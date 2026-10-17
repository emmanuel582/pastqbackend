import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildUtmeCollection, UTME_BUNDLE_ID } from '../services/library/utme.js';

const image = 'data:image/png;base64,iVBORw0KGgo=';
function source(id, subject, year, key) {
  return { id, title: subject, libraryMeta: { groupingStatus: 'grouped', groupKey: 'jamb', organization: { name: 'JAMB' }, exam: { name: 'UTME' }, publisher: { name: 'TestDriller' } }, questions: [
    { id: 1, practiceKey: key, subject, year, question: 'Same question repeated in a different source', options: ['One', 'Two'], correct: 1,
      questionHtml: `<div><img src="${image}">Question</div>`, optionsHtml: ['One', 'Two'], explanationHtml: `<img src="${image}">` },
  ] };
}
describe('one complete UTME collection', () => {
  it('keeps repeated source questions, unifies subjects and calendar years, and deduplicates image storage only', () => {
    const bank = buildUtmeCollection([source('old-accounting', 'Accounts', '2025 Model I', 'source-a'), source('old-topic', 'FINANCIAL ACCOUNTING', null, 'source-b')], { expectedCount: 2 });
    assert.equal(bank.questions.length, 2);
    assert.deepEqual(bank.questions.map(q => q.subject), ['Financial Accounting', 'Financial Accounting']);
    assert.deepEqual(bank.questions.map(q => q.year), ['2025', null]);
    assert.deepEqual(bank.questions.map(q => q.practiceKey), ['source-a', 'source-b']);
    assert.equal(bank.questions[0].sourceSet, '2025 Model I');
    assert.equal(bank.sourceAudit.imageReferences, 4);
    assert.equal(Object.keys(bank.assets).length, 1);
    assert.match(bank.questions[0].questionHtml, /pastq-asset:/);
    assert.equal(bank.sourceAudit.duplicatesRemoved, 0);
  });
  it('rejects a missing source or repeated source identity before writing', () => {
    assert.throws(() => buildUtmeCollection([source('a', 'Physics', '2025', 'a')], { expectedCount: 2 }), /Incomplete/);
    assert.throws(() => buildUtmeCollection([source('a', 'Physics', '2025', 'a'), source('b', 'Physics', '2024', 'a')], { expectedCount: 2 }), /duplicate source identity/);
  });
  it('publishes one catalog entry, serves compressed downloads and retains old saved links and files', async () => {
    const previous = process.env.DATA_DIR, previousLibrary = process.env.PASTQ_LIBRARY_DIR;
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-utme-'));
    process.env.DATA_DIR = data; delete process.env.PASTQ_LIBRARY_DIR;
    try {
      const store = await import('../services/library/store.js');
      const first = source('old-biology', 'Biology', '2025', 'bio');
      const second = source('old-physics', 'Physics', '2024', 'phy');
      store.saveBundle(first); store.saveBundle(second);
      const original = fs.readFileSync(path.join(data, 'library/bundles/old-biology.json'), 'utf8');
      const bank = buildUtmeCollection([first, second], { expectedCount: 2 });
      store.replaceLibraryCollections(bank, [first.id, second.id]);
      assert.equal(store.getBundle(first.id).id, UTME_BUNDLE_ID);
      assert.equal(store.listBundles().length, 1);
      assert.equal(store.getCatalog().organizations[0].examTypes[0].materials.length, 1);
      assert.equal(fs.readFileSync(path.join(data, 'library/bundles/old-biology.json'), 'utf8'), original);
      const download = store.getBundleDownload(first.id, true);
      assert.equal(download.encoding, 'gzip');
      assert.equal(JSON.parse(gunzipSync(fs.readFileSync(download.file))).questions.length, 2);
      assert.equal(store.getBundleDownload(UTME_BUNDLE_ID, false).encoding, null);
      assert.equal(store.listBundles({ summaries: true })[0].questions, undefined);
      assert.equal(store.searchBundles({ query: 'Physics' })[0].question_count, 2);
      assert.deepEqual(store.searchBundles({ examType: 'UTME' })[0].subjects, ['Biology', 'Physics']);
      store.replaceLibraryCollections(bank, [first.id, second.id]);
      assert.equal(store.getCatalog().organizations[0].examTypes[0].materials.length, 1);
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
      if (previousLibrary === undefined) delete process.env.PASTQ_LIBRARY_DIR; else process.env.PASTQ_LIBRARY_DIR = previousLibrary;
      assert.equal(path.dirname(data), os.tmpdir());
      fs.rmSync(data, { recursive: true });
    }
  });
});
