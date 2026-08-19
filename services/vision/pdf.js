/**
 * PDF intake for vision sessions.
 * Pages are obtained via Mistral OCR document mode (returns per-page markdown),
 * then fed into the same classify → extract → group pipeline as phone photos.
 * Source PDF is persisted under data/pages/<sessionId>/source.pdf for resume/debug.
 */
const fs = require('fs');
const path = require('path');
const { pageDir } = require('./store');

async function savePdfFile(sessionId, buffer, originalName = 'upload.pdf') {
  const dir = pageDir(sessionId);
  const filename = 'source.pdf';
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return {
    fullPath,
    filename,
    originalName,
    dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
  };
}

function ocrPagesToQueueItems(ocrPages, startIndex = 0) {
  return (ocrPages || []).map((page, i) => ({
    index: startIndex + i,
    markdown: page.markdown || '',
    source: 'pdf_ocr',
  }));
}

module.exports = {
  savePdfFile,
  ocrPagesToQueueItems,
};
