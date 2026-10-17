/** DATA_DIR=/persistent/data node scripts/consolidate-utme.mjs [--apply]
 * Audits every original source identity before publishing one offline UTME collection.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { LIBRARY_DIR, getBundle, replaceLibraryCollections } from '../services/library/store.js';
import { buildUtmeCollection, UTME_BUNDLE_ID } from '../services/library/utme.js';

if (!process.env.DATA_DIR || process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Set DATA_DIR; optional --apply');
const archive = path.join(LIBRARY_DIR(), 'source-imports/testdriller-utme-2027');
const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8'));
const originals = JSON.parse(fs.readFileSync(path.join(archive, 'questions.json'), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceIds = new Set(originals.map(question => hash(`${question.source}\0${question.number}\0${question.source_id}`)));
assert.equal(sourceIds.size, 42148);
const sourceBundles = manifest.bundles.map(record => JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR(), record.file), 'utf8')));
const bundle = buildUtmeCollection(sourceBundles);
const actualIds = new Set(bundle.questions.map(question => question.practiceKey.split(':').at(-1)));
assert.deepEqual(actualIds, sourceIds, 'Every original source question must appear exactly once');
assert.equal(bundle.sourceAudit.imageReferences, manifest.imageReferences);
assert.equal(bundle.questions.filter(question => question.type === 'short_answer').length, manifest.shortAnswerQuestions);
for (const [key, asset] of Object.entries(bundle.assets)) assert.equal(hash(Buffer.from(asset.data, 'base64')), key);
const existing = getBundle(UTME_BUNDLE_ID);
if (existing) assert.deepEqual(existing.questions, bundle.questions, 'Refuse to replace later reviewed content');
if (process.argv.includes('--apply')) replaceLibraryCollections(bundle, bundle.replacesBundleIds);
console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'applied' : 'validated', id: bundle.id,
  ...bundle.sourceAudit, serializedBytes: Buffer.byteLength(JSON.stringify(bundle)), originalSourceIdsMatched: true }));
