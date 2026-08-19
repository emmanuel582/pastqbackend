const sharp = require('sharp');
const heicConvert = require('heic-convert');
const fs = require('fs');
const path = require('path');
const { pageDir } = require('./store');
const { IMAGE_PREP } = require('./models');

/**
 * Normalize uploads for OCR: rotate, cap dimensions, moderate JPEG quality.
 * Cuts payload size/cost while keeping exam text readable.
 */
async function toJpegBuffer(inputBuffer) {
  const { maxWidth, maxHeight, jpegQuality } = IMAGE_PREP;
  try {
    return await sharp(inputBuffer, { unlimited: true })
      .rotate()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();
  } catch {
    const converted = Buffer.from(
      await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: Math.min(0.92, jpegQuality / 100),
      })
    );
    return sharp(converted, { unlimited: true })
      .rotate()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();
  }
}

async function savePageImage(sessionId, pageIndex, inputBuffer) {
  const jpeg = await toJpegBuffer(inputBuffer);
  const dir = pageDir(sessionId);
  const filename = `page-${String(pageIndex).padStart(4, '0')}.jpg`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, jpeg);
  return { fullPath, filename, jpeg, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
}

function isPdf(file) {
  if (!file) return false;
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

module.exports = {
  toJpegBuffer,
  savePageImage,
  isPdf,
};
