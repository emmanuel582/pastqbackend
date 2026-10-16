/**
 * Exact figures.
 *
 * Diagrams are cut from the original page raster with the bounding box the
 * model confirmed after seeing its own crop, so the stored figure is exactly
 * the source pixels it approved. Crops live under data/pages/<sessionId>/figures/.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { pageDir, getDataRoot } from './store.js';
import { bboxProblems } from './contract.js';

/** Pixel rectangle for a validated 0-1000 box on an image of width×height. */
function bboxToRect([x0, y0, x1, y1], width, height) {
  const left = Math.floor((x0 / 1000) * width);
  const top = Math.floor((y0 / 1000) * height);
  const right = Math.ceil((x1 / 1000) * width);
  const bottom = Math.ceil((y1 / 1000) * height);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function cropRegion(imagePath, bbox) {
  const problems = bboxProblems(bbox, 'crop');
  if (problems.length) throw new Error(problems.join('; '));
  const input = fs.readFileSync(imagePath);
  const meta = await sharp(input).metadata();
  const rect = bboxToRect(bbox, meta.width, meta.height);
  const buffer = await sharp(input).extract(rect).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { buffer, rect };
}

/**
 * Save every confirmed figure on a page's questions and attach its URL.
 * A box shared by several questions is saved once.
 */
async function cropPageFigures(sessionId, page, questions) {
  const dir = path.join(pageDir(sessionId), 'figures');
  fs.mkdirSync(dir, { recursive: true });
  const saved = new Map();
  let n = 0;
  for (const q of questions) {
    for (const fig of q.figures) {
      const key = JSON.stringify(fig.bbox);
      if (!saved.has(key)) {
        const crop = await cropRegion(page.imagePath, fig.bbox);
        // Random suffix: figures are served without a bearer token (<img src>),
        // so their URLs must be unguessable.
        const file = `p${String(page.index).padStart(6, '0')}-f${++n}-${crypto.randomBytes(6).toString('hex')}.jpg`;
        fs.writeFileSync(path.join(dir, file), crop.buffer);
        saved.set(key, { file, width: crop.rect.width, height: crop.rect.height });
      }
      Object.assign(fig, saved.get(key), { url: `/api/library/figures/${sessionId}/${saved.get(key).file}`, pageIndex: page.index });
    }
  }
  return questions;
}

/** Safe path for serving a stored figure; null when the name is not a figure file. */
function figurePath(sessionId, file) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(sessionId || ''))) return null;
  if (!/^p\d{6}-f\d+-[0-9a-f]{12}\.jpg$/.test(String(file || ''))) return null;
  const full = path.join(getDataRoot(), 'pages', sessionId, 'figures', file);
  return fs.existsSync(full) ? full : null;
}

export { bboxToRect, cropRegion, cropPageFigures, figurePath };
