// Remove the tiny residual color/matte drift left by background removal when
// the generated first and last poses already match. Work in premultiplied
// space so invisible RGB cannot create halos along the soft silhouette.
export function normalizeEndpoint(rgba, width, height, windowFrames = 12) {
  const size = width * height * 4;
  const count = rgba.length / size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || !Number.isInteger(count) || !Number.isInteger(windowFrames)
      || windowFrames < 3 || windowFrames > count) {
    throw new Error('Expected complete RGBA frames and a correction window of 3 to frame count');
  }
  const output = new Uint8Array(rgba);
  const last = (count - 1) * size;
  for (let offset = 0; offset < windowFrames; offset++) {
    const t = offset / (windowFrames - 1), weight = t * t * (3 - 2 * t);
    if (weight === 0) continue;
    const frame = (count - windowFrames + offset) * size;
    for (let pixel = 0; pixel < size; pixel += 4) {
      const current = frame + pixel;
      const startAlpha = rgba[pixel + 3], endAlpha = rgba[last + pixel + 3];
      const oldAlpha = rgba[current + 3];
      const alpha = Math.max(0, Math.min(255, oldAlpha + weight * (startAlpha - endAlpha)));
      output[current + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel++) {
        const residual = (rgba[pixel + channel] * startAlpha - rgba[last + pixel + channel] * endAlpha) / 255;
        const color = rgba[current + channel] * oldAlpha / 255 + weight * residual;
        output[current + channel] = alpha === 0 ? 0 : Math.round(Math.max(0, Math.min(alpha, color)) * 255 / alpha);
      }
    }
  }
  output.set(rgba.subarray(0, size), last);
  return output;
}
