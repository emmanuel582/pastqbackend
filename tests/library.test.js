import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('library store', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-lib-'));
    process.env.PASTQ_LIBRARY_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.PASTQ_LIBRARY_DIR;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('mergeQuestions dedupes by normalized text', async () => {
    const { mergeQuestions } = await import(`../services/library/store.js?test=${Date.now()}`);
    const a = [{ question: 'What is GDP in Nigeria?' }];
    const b = [{ question: 'What is GDP in Nigeria?' }, { question: 'Define inflation rate?' }];
    const merged = mergeQuestions(a, b);
    assert.equal(merged.length, 2);
  });

  it('upsertSessionToLibrary keeps manufacturers as siblings', async () => {
    const store = await import(`../services/library/store.js?test=${Date.now()}-a`);
    const metaA = {
      university: 'Biology',
      examType: 'Past questions',
      manufacturer: 'Primax Preversity',
      manufacturerSource: 'booklet_label',
    };
    const metaB = {
      university: 'Biology',
      examType: 'Past questions',
      manufacturer: 'Success Tutorial',
      manufacturerSource: 'booklet_label',
    };

    const sessionA = {
      id: 'sess-a',
      name: 'Primax',
      questions: [{ subject: 'Biology', question: 'Primax question one here?', options: ['A', 'B'], year: '2020' }],
      groups: [],
    };
    const sessionB = {
      id: 'sess-b',
      name: 'Success',
      questions: [{ subject: 'Biology', question: 'Success tutorial question here?', options: ['A', 'B'], year: '2019' }],
      groups: [],
    };

    store.upsertSessionToLibrary(sessionA, metaA);
    store.upsertSessionToLibrary(sessionB, metaB);

    const catalog = store.getCatalog();
    const ui = catalog.universities.find((u) => u.name === 'Biology');
    assert.ok(ui);
    const exam = ui.examTypes.find((e) => e.name === 'Past questions');
    assert.ok(exam);
    assert.equal(exam.manufacturers.length, 2);
    const names = exam.manufacturers.map((m) => m.name).sort();
    assert.deepEqual(names, ['Primax Preversity', 'Success Tutorial']);
  });

  it('upsertSessionToLibrary merges same manufacturer', async () => {
    const store = await import(`../services/library/store.js?test=${Date.now()}-b`);
    const meta = {
      university: 'Biology',
      examType: 'Past questions',
      manufacturer: 'Primax Preversity',
      manufacturerSource: 'booklet_label',
    };

    store.upsertSessionToLibrary(
      {
        id: 'sess-1',
        questions: [{ subject: 'Math', question: 'First primax math question here?', options: ['A'], year: '2020' }],
        groups: [],
      },
      meta
    );
    store.upsertSessionToLibrary(
      {
        id: 'sess-2',
        questions: [{ subject: 'Math', question: 'Second primax math question here?', options: ['A'], year: '2021' }],
        groups: [],
      },
      meta
    );

    const catalog = store.getCatalog();
    const mfg = catalog.universities[0].examTypes[0].manufacturers;
    assert.equal(mfg.length, 1);
    const bundle = store.getBundle(mfg[0].bundleId);
    assert.equal(bundle.questions.length, 2);
  });

  it('keeps uncertain uploads outside verified organization groups', async () => {
    const store = await import(`../services/library/store.js?test=${Date.now()}-ungrouped`);
    store.upsertSessionToLibrary({
      id: 'uncertain-session', name: 'Random practice sheet', groups: [],
      questions: [{ subject: 'Biology', question: 'Which structure contains chlorophyll?', options: ['Cell wall', 'Chloroplast'] }],
    }, {
      taxonomyVersion: 2,
      groupingStatus: 'ungrouped',
      groupConfidence: 0,
      groupKey: null,
      organization: { name: null, confidence: 0, evidence: [] },
      exam: { name: null, confidence: 0, evidence: [] },
      publisher: { name: null, confidence: 0, evidence: [] },
      reasonCodes: ['organization_not_evidenced'],
    });
    const catalog = store.getCatalog();
    assert.equal(catalog.organizations.length, 0);
    assert.equal(catalog.ungrouped.length, 1);
  });
});

describe('libraryClassifier', () => {
  it('builds stable manufacturer keys', async () => {
    const { manufacturerKey } = await import('../services/vision/libraryClassifier.js');
    const key = manufacturerKey({ university: 'Biology', examType: 'Past questions', manufacturer: 'Primax Preversity' });
    assert.equal(key, 'biology::past-questions::primax-preversity');
  });
});
