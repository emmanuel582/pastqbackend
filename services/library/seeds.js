import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSeedBundle } from './store.js';
import { dataRoot } from './figures.js';

const seedDir = fileURLToPath(new URL('../../seeds/chemistry-remix/', import.meta.url));

/** Restore shipped question content and figures into the configured persistent disk. */
export function installLibrarySeeds() {
  const seed = JSON.parse(fs.readFileSync(path.join(seedDir, 'bundle.json'), 'utf8'));
  const figures = new Map();
  for (const question of seed.questions) {
    for (const figure of question.figures || []) {
      if (!figure.file) continue;
      const match = /^\/api\/library\/figures\/([A-Za-z0-9-]{8,64})\/(p\d{6}-f\d+-[0-9a-f]{12}\.jpg)$/.exec(figure.url || '');
      if (!match || match[2] !== figure.file) throw new Error('Invalid seed figure reference');
      const source = path.join(seedDir, 'figures', figure.file);
      fs.accessSync(source, fs.constants.R_OK);
      figures.set(path.join(dataRoot(), 'pages', match[1], 'figures', figure.file), source);
    }
  }
  for (const [destination, source] of figures) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return installSeedBundle(seed);
}
