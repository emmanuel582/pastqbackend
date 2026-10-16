/**
 * Page image intake: safe decode (size/pixel limits, HEIC), EXIF rotation,
 * white background, size cap. No quality heuristics — legibility is judged
 * by the vision model, which can zoom into the full-resolution original.
 */
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import fs from 'fs';
import path from 'path';
import { pageDir } from './store.js';

const MAX_INPUT_PIXELS = Number(process.env.VISION_MAX_INPUT_PIXELS || 100_000_000);
const MAX_INPUT_BYTES = Number(process.env.VISION_MAX_INPUT_BYTES || 40 * 1024 * 1024);
const MAX_SIDE = Number(process.env.VISION_MAX_SIDE || 4200);
const JPEG_QUALITY = Number(process.env.VISION_JPEG_QUALITY || 94);

async function safeSharpBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) throw new Error('Image file is empty');
  if (inputBuffer.length > MAX_INPUT_BYTES) throw new Error(`Image exceeds ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB`);
  try {
    const metadata = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Image dimensions could not be read');
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw new Error(`Image exceeds ${MAX_INPUT_PIXELS.toLocaleString()} pixels`);
    return { buffer: inputBuffer, metadata };
  } catch (firstError) {
    // HEIC/HEIF (phone photos) is the only container given a second decoder;
    // arbitrary failed images are never re-decoded.
    const brand = inputBuffer.subarray(4, 16).toString('ascii').toLowerCase();
    const isHeicContainer = brand.startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].some((b) => brand.includes(b));
    if (!isHeicContainer) throw firstError;
    const converted = Buffer.from(await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.95 }));
    const metadata = await sharp(converted, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) throw firstError;
    return { buffer: converted, metadata };
  }
}

async function prepareImage(inputBuffer) {
  const safe = await safeSharpBuffer(inputBuffer);
  const base = await sharp(safe.buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { base, original: safe.metadata };
}

async function savePageImage(sessionId, pageIndex, inputBuffer) {
  const prepared = await prepareImage(inputBuffer);
  const filename = `page-${String(pageIndex).padStart(6, '0')}.jpg`;
  const fullPath = path.join(pageDir(sessionId), filename);
  fs.writeFileSync(fullPath, prepared.base);
  return { fullPath, filename, original: prepared.original };
}

function isPdf(file) {
  if (!file) return false;
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

export { MAX_INPUT_PIXELS, prepareImage, savePageImage, isPdf };
