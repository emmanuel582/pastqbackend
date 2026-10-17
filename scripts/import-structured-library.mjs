/** Direct, verified import. No model calls, deduplication or answer rewriting.
 * DATA_DIR=/persistent/data node scripts/import-structured-library.mjs /staged/import [--apply]
 * Run the normal backup before --apply. Repeating an identical import is safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [input, flag] = process.argv.slice(2);
if (!input || !process.env.DATA_DIR || (flag && flag !== '--apply')) {
  throw new Error('Set DATA_DIR; usage: import-structured-library.mjs <directory> [--apply]');
}
const root = fs.realpathSync(input);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.format !== 'pastq-structured-import-v1' || !/^[a-z0-9-]{8,64}$/.test(manifest.id)) throw new Error('Invalid manifest');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function verified(record) {
  const file = fs.realpathSync(path.resolve(root, record.file));
  if (!file.startsWith(root + path.sep)) throw new Error('Import path escapes directory');
  const data = fs.readFileSync(file);
  if (data.length !== record.bytes || hash(data) !== record.sha256) throw new Error(`Checksum mismatch: ${record.file}`);
  return data;
}
const { installSeedBundle, getBundle, getCatalog } = await import('../services/library/store.js');
let total = 0;
const ids = new Set();
const collections = new Set();
const keys = new Set();
const images = new Set();
let imageReferences = 0;
let shortAnswer = 0;
for (const record of manifest.bundles) {
  const bundle = JSON.parse(verified(record));
  if (bundle.id !== record.id || !/^[A-Za-z0-9_-]{8,64}$/.test(bundle.id)
    || ids.has(bundle.id) || bundle.questions?.length !== record.questions) throw new Error('Bundle manifest mismatch');
  ids.add(bundle.id);
  const meta = bundle.libraryMeta;
  if (meta?.groupingStatus !== 'grouped' || !meta.collectionKey || !meta.groupKey || !meta.exam?.name || !meta.publisher?.name) throw new Error('Reviewed collection metadata required');
  const collection = [meta.groupKey, meta.exam.name, meta.collectionKey].join(':');
  if (collections.has(collection)) throw new Error('Duplicate collection');
  collections.add(collection);
  for (const q of bundle.questions) {
    const isShortAnswer = q.type === 'short_answer' && q.options?.length === 1 && q.correct === null && q.answerText;
    if (!q.practiceKey || keys.has(q.practiceKey) || !Array.isArray(q.options) || q.options.length < 1
      || (!isShortAnswer && (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length))
      || q.optionsHtml?.length !== q.options.length) throw new Error(`Invalid source question: ${bundle.id}/${q.id}; duplicate=${keys.has(q.practiceKey)}; options=${q.options?.length}; correct=${q.correct}`);
    shortAnswer += Number(Boolean(isShortAnswer));
    keys.add(q.practiceKey);
    for (const html of [q.questionHtml, ...q.optionsHtml, q.explanationHtml]) {
      for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
        if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(match[1])) throw new Error('Non-embedded image');
        imageReferences++;
        images.add(hash(Buffer.from(match[1].split(',')[1], 'base64')));
      }
    }
  }
  total += bundle.questions.length;
  const existing = getBundle(bundle.id);
  if (existing && JSON.stringify(existing.questions) !== JSON.stringify(bundle.questions)) throw new Error(`Existing content differs: ${bundle.id}`);
  const catalog = getCatalog();
  const matching = catalog.organizations.find(org => org.id === meta.groupKey)?.examTypes
    ?.find(exam => exam.name === meta.exam.name)?.materials?.find(m => m.collectionKey === meta.collectionKey);
  if (matching && matching.bundleId !== bundle.id) throw new Error('Catalog collection already belongs to another bundle');
}
for (const record of manifest.originals) verified(record);
if (total !== manifest.questionCount || ids.size !== manifest.bundleCount
  || imageReferences !== manifest.imageReferences || shortAnswer !== manifest.shortAnswerQuestions
  || total - shortAnswer !== manifest.multipleChoiceQuestions) throw new Error('Incomplete import');

let installed = 0;
if (flag === '--apply') {
  // All input and existing content is verified before the first persistent write.
  const archive = path.join(process.env.DATA_DIR, 'library', 'source-imports', manifest.id);
  fs.mkdirSync(archive, { recursive: true });
  for (const record of manifest.originals) {
    const file = path.join(archive, path.basename(record.file));
    if (fs.existsSync(file)) {
      if (hash(fs.readFileSync(file)) !== record.sha256) throw new Error('Existing original archive differs');
    } else {
      const temp = file + '.tmp';
      fs.writeFileSync(temp, verified(record), { mode: 0o600 });
      fs.renameSync(temp, file);
    }
  }
  for (const record of manifest.bundles) {
    const result = installSeedBundle(JSON.parse(verified(record)));
    if (result.bundle.id !== record.id || result.bundle.questions.length !== record.questions) throw new Error('Library installation mismatch');
    installed += Number(result.installed);
  }
  fs.writeFileSync(path.join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const listed = getCatalog().organizations.flatMap(org => org.examTypes.flatMap(exam => exam.materials || []));
  if (listed.filter(item => ids.has(item.bundleId)).length !== ids.size) throw new Error('Not all imported collections are listed');
}
console.log(JSON.stringify({ mode: flag === '--apply' ? 'applied' : 'validated', questions: total,
  bundles: ids.size, multipleChoiceQuestions: total - shortAnswer, shortAnswerQuestions: shortAnswer,
  imageReferences, uniqueImageContents: images.size, installed, aiUsed: false }));
