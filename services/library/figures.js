import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function dataRoot() {
  return path.resolve(process.env.DATA_DIR || process.env.PASTQ_DATA_DIR
    || fileURLToPath(new URL('../../data/', import.meta.url)));
}

export function libraryFigurePath(sessionId, file) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)
    || !/^p\d{6}-f\d+-[0-9a-f]{12}\.jpg$/.test(file)) return null;
  const target = path.join(dataRoot(), 'pages', sessionId, 'figures', file);
  return fs.existsSync(target) ? target : null;
}
