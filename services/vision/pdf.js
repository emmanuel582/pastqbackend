/**
 * PDF intake.
 * Every page is rasterised to an image on disk — scanned and digital PDFs are
 * treated the same, because the vision model reads the page itself (a PDF's
 * embedded text layer is often a poor OCR of a scan and is not used).
 * Pages are rendered in parallel worker threads. The source PDF is kept under
 * data/pages/<sessionId>/source.pdf.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { pageDir } from './store.js';

const MAX_PDF_BYTES = Number(process.env.VISION_MAX_PDF_BYTES || 200 * 1024 * 1024);
const PDF_SCALE = Number(process.env.VISION_PDF_SCALE || 2.5);
const RASTER_WORKERS = Number(process.env.VISION_RASTER_WORKERS || Math.max(1, Math.min(8, os.cpus().length - 1)));

function validatePdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('PDF file is empty or invalid');
  if (buffer.length > MAX_PDF_BYTES) throw new Error(`PDF exceeds ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB`);
  // MIME and filename are user-controlled: require the actual PDF signature,
  // allowing the leading whitespace some scanners emit.
  const signature = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  if (!/^\s*%PDF-/i.test(signature)) throw new Error('Uploaded file is not a valid PDF');
}

/** Store an uploaded PDF in the session folder; returns its path. */
async function savePdfFile(sessionId, buffer, originalName = 'upload.pdf') {
  validatePdfBuffer(buffer);
  const n = fs.readdirSync(pageDir(sessionId)).filter((f) => /^source(-\d+)?\.pdf$/.test(f)).length;
  const filename = n ? `source-${n}.pdf` : 'source.pdf';
  const fullPath = path.join(pageDir(sessionId), filename);
  fs.writeFileSync(fullPath, buffer);
  return { fullPath, filename, originalName };
}

async function pdfPageCount(pdfPath) {
  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(pdfPath, { scale: 1 });
  return doc.length;
}

/**
 * Rasterise a stored PDF across worker threads. `onPage(page)` is awaited for
 * each finished page (pages arrive out of order; each carries its index).
 */
async function rasterizePdfToPages(sessionId, pdfPath, { startIndex = 0, onPage }) {
  const total = await pdfPageCount(pdfPath);
  if (!total) throw new Error('PDF has no renderable pages');
  const workers = Math.min(RASTER_WORKERS, total);
  const assignments = Array.from({ length: workers }, () => []);
  for (let n = 1; n <= total; n++) assignments[(n - 1) % workers].push(n);

  let chain = Promise.resolve();
  const running = [];
  await Promise.all(assignments.map((pageNumbers) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rasterWorker.js', import.meta.url), {
      workerData: { pdfPath, sessionId, pageNumbers, startIndex, scale: PDF_SCALE },
      // Workers inherit the parent's flags; --input-type only applies to --eval scripts.
      execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
    });
    running.push(worker);
    worker.on('message', (msg) => {
      if (msg.type === 'page') chain = chain.then(() => onPage(msg.page));
      else if (msg.type === 'done') chain.then(resolve, reject);
      else if (msg.type === 'error') reject(new Error(`Page rendering failed: ${msg.message}`));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Rasteriser exited with code ${code}`)); });
  }))).catch(async (err) => {
    // One failed worker fails the ingest: stop the others instead of leaving them rendering.
    await Promise.all(running.map((w) => w.terminate()));
    throw err;
  });
  await chain;
  return total;
}

export { MAX_PDF_BYTES, validatePdfBuffer, savePdfFile, rasterizePdfToPages, pdfPageCount };
