export const IMAGE_UPLOAD_ACCEPT = 'image/*,.heic,.heif,.tif,.tiff';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DIRECT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function prepareImageUpload(file: File): Promise<File> {
  if (!file.size) throw new Error('This image is empty. Please choose another file.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Please choose an image smaller than 50 MB.');
  const heic = /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
  const tiff = /\.tiff?$/i.test(file.name) || file.type === 'image/tiff';
  if (!heic && !tiff && !file.type.startsWith('image/') && !/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)$/i.test(file.name)) {
    throw new Error('Please choose an image file.');
  }
  // Provider-native formats need no conversion; keep GIF animation intact.
  if (DIRECT_TYPES.has(file.type) && file.size <= 4 * 1024 * 1024) return file;
  let blob: Blob = file;
  if (heic) {
    const { heicTo } = await import('heic-to/csp');
    blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to prepare this image in your browser.');
  if (tiff) {
    const module = await import('utif');
    const UTIF = module.default;
    const buffer = await file.arrayBuffer();
    const frames = UTIF.decode(buffer);
    const frame = frames[0];
    if (!frame) throw new Error('Unable to read this TIFF image.');
    const width = Number((frame.t256 as number[] | undefined)?.[0]);
    const height = Number((frame.t257 as number[] | undefined)?.[0]);
    if (!width || !height) throw new Error('Unable to read this TIFF image.');
    if (width * height > 40_000_000) throw new Error('Please choose an image smaller than 40 megapixels.');
    UTIF.decodeImage(buffer, frame);
    canvas.width = frame.width;
    canvas.height = frame.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(frame)), frame.width, frame.height), 0, 0);
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally { URL.revokeObjectURL(url); }
  }
  const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    result => result ? resolve(result) : reject(new Error('Unable to convert this image.')), 'image/jpeg', 0.9,
  ));
  if (output.size > 4 * 1024 * 1024) throw new Error('This image is too large to process. Please choose a smaller image.');
  return new File([output], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}
