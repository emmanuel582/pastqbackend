/**
 * Worker thread: rasterise an assigned subset of a PDF's pages and save each
 * as a page image. Runs in parallel with sibling workers (see pdf.js).
 */
import { parentPort, workerData } from 'worker_threads';
import { pdf } from 'pdf-to-img';
import { savePageImage } from './image.js';

const { pdfPath, sessionId, pageNumbers, startIndex, scale } = workerData;

try {
  const doc = await pdf(pdfPath, { scale });
  for (const n of pageNumbers) {
    const png = await doc.getPage(n);
    const index = startIndex + n - 1;
    const saved = await savePageImage(sessionId, index, png);
    parentPort.postMessage({ type: 'page', page: { index, pdfPage: n, imagePath: saved.fullPath, width: saved.original?.width || null, height: saved.original?.height || null } });
  }
  parentPort.postMessage({ type: 'done' });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
}
