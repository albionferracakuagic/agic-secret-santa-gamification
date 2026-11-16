import sharp from 'sharp';

export class ImageError extends Error {
  constructor() {
    super('invalid_image');
  }
}

export interface ProcessedImage {
  data: Buffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

const ALLOWED = new Set(['jpeg', 'png', 'webp']);
export const MAX_DIMENSION = 1600;

/**
 * Gift photo pipeline: validate real image content (not the extension), apply EXIF orientation, resize to
 * <= 1600 px, re-encode as JPEG. sharp does not copy metadata unless asked, so EXIF/GPS/ICC are dropped.
 */
export async function processGiftPhoto(input: Buffer): Promise<ProcessedImage> {
  try {
    const probe = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
    if (!probe.format || !ALLOWED.has(probe.format)) throw new ImageError();
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, mime: 'image/jpeg', width: info.width, height: info.height };
  } catch {
    throw new ImageError();
  }
}
