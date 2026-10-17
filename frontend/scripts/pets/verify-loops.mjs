import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Compare premultiplied color on both light and dark backgrounds. Invisible
// RGB must not count as motion, but a discontinuity in the alpha mask must.
export function measureLoop(rgba, width, height) {
  const frameSize = width * height * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || rgba.length % frameSize || rgba.length < frameSize * 3) {
    throw new Error('Expected at least three complete RGBA frames');
  }
  const count = rgba.length / frameSize;
  const foreground = [];
  for (let pixel = 0; pixel < frameSize; pixel += 4) {
    for (let frame = 0; frame < count; frame++) {
      if (rgba[frame * frameSize + pixel + 3] > 32) {
        foreground.push(pixel);
        break;
      }
    }
  }
  if (!foreground.length) throw new Error('Animation has no visible subject');
  const difference = (left, right) => {
    let dark = 0, light = 0;
    for (const pixel of foreground) {
      const a = left * frameSize + pixel, b = right * frameSize + pixel;
      const aa = rgba[a + 3] / 255, ba = rgba[b + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const delta = rgba[a + channel] * aa - rgba[b + channel] * ba;
        dark += Math.abs(delta);
        light += Math.abs(delta + 255 * (ba - aa));
      }
    }
    return Math.max(dark, light) / (foreground.length * 3);
  };
  const alphaMinimum = { clear: 1, opaque: 1, soft: 1 };
  for (let frame = 0; frame < count; frame++) {
    let clear = 0, opaque = 0, soft = 0;
    for (let pixel = 3; pixel < frameSize; pixel += 4) {
      const alpha = rgba[frame * frameSize + pixel];
      if (alpha === 0) clear++;
      else if (alpha === 255) opaque++;
      else soft++;
    }
    alphaMinimum.clear = Math.min(alphaMinimum.clear, clear / (width * height));
    alphaMinimum.opaque = Math.min(alphaMinimum.opaque, opaque / (width * height));
    alphaMinimum.soft = Math.min(alphaMinimum.soft, soft / (width * height));
  }
  const steps = Array.from({ length: count - 1 }, (_, frame) => difference(frame, frame + 1));
  const seam = difference(count - 1, 0);
  return {
    frames: count,
    alpha_minimum_fraction: alphaMinimum,
    seam_mae: seam,
    median_step_mae: median(steps),
    max_step_mae: Math.max(...steps),
    boundary_step_max: Math.max(...steps.slice(0, 6), ...steps.slice(-6)),
  };
}

export function assertLoopQuality(metrics) {
  if (metrics.median_step_mae < 0.05) throw new Error('Animation is static');
  if (metrics.seam_mae > 2 || metrics.seam_mae > metrics.median_step_mae * 0.5 + 0.35) {
    throw new Error(`Loop jumps at the boundary (${metrics.seam_mae.toFixed(3)} MAE)`);
  }
  if (metrics.boundary_step_max > Math.max(metrics.median_step_mae * 3, 2)) {
    throw new Error('Motion changes abruptly near the loop boundary');
  }
}

export function assertAlphaQuality(metrics) {
  const alpha = metrics.alpha_minimum_fraction;
  if (alpha.clear < 0.4 || alpha.opaque < 0.05 || alpha.soft < 0.001) {
    throw new Error('Animation must retain transparent background, visible subject and soft edges in every frame');
  }
}

export function verifyWebm(path) {
  const decoded = spawnSync('ffmpeg', [
    '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
    '-vf', 'scale=128:128', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: 32 * 1024 * 1024 });
  if (decoded.error) throw decoded.error;
  if (decoded.status !== 0) throw new Error(decoded.stderr.toString());
  const metrics = measureLoop(decoded.stdout, 128, 128);
  assertLoopQuality(metrics);
  assertAlphaQuality(metrics);
  return { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), ...metrics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('Pass one or more transparent WebM paths');
  for (const path of paths) console.log(JSON.stringify({ path, ...verifyWebm(path) }));
}
