/** DATA_DIR=/persistent/data node scripts/import-waec.mjs /staged/testdriller-ssce-2027 [--apply] */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { buildWaecCollections, WAEC_SOURCE_SHA256, WAEC_SOURCE_COUNT } from '../services/library/waec.js';

const [directory, flag] = process.argv.slice(2);
if (!directory || !process.env.DATA_DIR || flag && flag !== '--apply') throw new Error('Set DATA_DIR; supply export directory and optional --apply');
const input = fs.realpathSync(directory);
const source = fs.readFileSync(path.join(input, 'questions.json'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(source), WAEC_SOURCE_SHA256, 'The complete original export must match');
const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'), 'utf8'));
const validation = JSON.parse(fs.readFileSync(path.join(input, 'validation.json'), 'utf8'));
assert.equal(manifest.questionCount, WAEC_SOURCE_COUNT);
const assetCache = new Map();
const bundles = buildWaecCollections(JSON.parse(source.toString('utf8')), src => {
  if (assetCache.has(src)) return assetCache.get(src);
  const file = fs.realpathSync(path.join(input, src));
  assert.ok(file.startsWith(input + path.sep));
  const bytes = fs.readFileSync(file);
  if (!bytes.length) { const asset = { mime: 'image/png', data: '', unavailable: 'empty_source_image' }; assetCache.set(src,asset); return asset; }
  const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(0,4).toString() === 'RIFF' ? 'image/webp' : bytes.subarray(0,3).toString() === 'GIF' ? 'image/gif' : null;
  assert.ok(mime, `Unsupported image: ${src}`);
  const asset = { mime, data: bytes.toString('base64') }; assetCache.set(src, asset); return asset;
});
assert.equal(bundles.reduce((sum,b) => sum + b.questions.length,0), WAEC_SOURCE_COUNT);
assert.equal(bundles.reduce((sum,b) => sum + (b.sourceAudit.sourceImageReferences || 0),0), validation.verifiedImageReferences);
assert.equal(assetCache.size, validation.verifiedImageFiles);
const { getBundle, installSeedBundle, LIBRARY_DIR } = await import('../services/library/store.js');
for (const bundle of bundles) {
  const existing = getBundle(bundle.id);
  if (existing) assert.deepEqual(existing.questions, bundle.questions, 'Refuse to overwrite later edits');
}
if (flag === '--apply') {
  const archive = path.join(LIBRARY_DIR(), 'source-imports', 'testdriller-ssce-2027');
  fs.mkdirSync(archive, { recursive: true });
  for (const name of ['questions.json','manifest.json','validation.json','assets-manifest.json','source-files.json','README.txt']) {
    const bytes = fs.readFileSync(path.join(input,name)), target = path.join(archive,name);
    if (fs.existsSync(target)) assert.equal(hash(fs.readFileSync(target)),hash(bytes));
    else { fs.writeFileSync(target+'.tmp',bytes,{mode:0o600}); fs.renameSync(target+'.tmp',target); }
  }
  const originals = path.join(input,'originals','source-question-files.zip'), originalTarget = path.join(archive,'source-question-files.zip');
  if (fs.existsSync(originalTarget)) assert.equal(hash(fs.readFileSync(originalTarget)),hash(fs.readFileSync(originals)));
  else fs.copyFileSync(originals, originalTarget);
  fs.mkdirSync(path.join(archive,'assets'),{recursive:true});
  for (const src of assetCache.keys()) {
    const target = path.join(archive,src), original = path.join(input,src);
    if (fs.existsSync(target)) assert.equal(hash(fs.readFileSync(target)),hash(fs.readFileSync(original)));
    else fs.copyFileSync(original,target);
  }
  for (const bundle of bundles) {
    const result = installSeedBundle(bundle);
    assert.equal(result.bundle.id,bundle.id); assert.equal(result.bundle.questions.length,bundle.questions.length);
  }
}
console.log(JSON.stringify({mode:flag==='--apply'?'applied':'validated',questions:WAEC_SOURCE_COUNT,collections:bundles.map(b=>({id:b.id,title:b.title,...b.sourceAudit})),missingSourceDiagrams:manifest.missingImageReferences,aiUsed:false}));
