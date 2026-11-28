import QRCode from 'qrcode';

const WIDTH = 1800;
const HEIGHT = 1200;
const ART_WIDTH = 980;

type PostcardPalette = { paper: string; ink: string; art: [string, string, string] };

export function postcardModelBounds(pixels: ImageData) {
  const { data, width, height } = pixels;
  let left = width, top = height, right = -1, bottom = -1;
  let hasTransparency = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) hasTransparency = true;
      if (alpha < 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (!hasTransparency || right < left) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

export async function renderPostcardFront(modelPng: string, title: string, instructionsUrl: string, palette: PostcardPalette): Promise<Blob> {
  const model = new Image();
  model.src = modelPng;
  await model.decode();

  const source = document.createElement('canvas');
  source.width = model.naturalWidth;
  source.height = model.naturalHeight;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Could not read the model render.');
  sourceContext.drawImage(model, 0, 0);
  const bounds = postcardModelBounds(sourceContext.getImageData(0, 0, source.width, source.height));
  if (!bounds) throw new Error('The model render needs a transparent background.');

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the postcard artwork.');

  ctx.fillStyle = palette.paper;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const gradient = ctx.createLinearGradient(0, 0, ART_WIDTH, HEIGHT);
  const [start, middle, end] = palette.art;
  gradient.addColorStop(0, start);
  gradient.addColorStop(0.5, middle);
  gradient.addColorStop(1, end);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, ART_WIDTH, HEIGHT);

  const scale = Math.min(790 / bounds.width, 900 / bounds.height);
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  ctx.save();
  ctx.shadowColor = '#25202b55';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 22;
  ctx.drawImage(model, bounds.left, bounds.top, bounds.width, bounds.height,
    (ART_WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
  ctx.restore();

  const center = (ART_WIDTH + WIDTH) / 2;
  ctx.fillStyle = palette.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const normalizedTitle = title.trim().replace(/\s+/g, ' ');
  const lines = normalizedTitle.length > 22
    ? normalizedTitle.match(/.{1,25}(?:\s|$)|.{1,25}/gu)?.map(line => line.trim()) ?? []
    : [normalizedTitle];
  const titleSize = Math.min(76, 204 / Math.max(1, lines.length));
  ctx.font = `${titleSize}px Georgia, serif`;
  lines.forEach((line, index) => ctx.fillText(line, center, 249 + (index - (lines.length - 1) / 2) * titleSize, 650));

  const qr = await QRCode.toCanvas(instructionsUrl, {
    errorCorrectionLevel: 'M',
    width: 428,
    margin: 4,
    color: { dark: '#17202a', light: '#ffffff' },
  });
  ctx.drawImage(qr, Math.round(center - qr.width / 2), 378);
  ctx.font = '600 36px Arial, sans-serif';
  ctx.fillText('Scan to start building', center, 878);
  ctx.font = '29px Arial, sans-serif';
  ctx.fillText('brickbuilder.ai', center, 970);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not save the postcard artwork.')), 'image/png');
  });
}
