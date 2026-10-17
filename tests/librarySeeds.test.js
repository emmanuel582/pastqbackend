import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('shipped Chemistry Remix library', () => {
  let dataDir;
  let previousDataDir;
  let previousLibraryDir;
  let store;
  let seeds;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    previousLibraryDir = process.env.PASTQ_LIBRARY_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-seed-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.PASTQ_LIBRARY_DIR;
    store = await import('../services/library/store.js');
    seeds = await import('../services/library/seeds.js');
  });
  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousLibraryDir === undefined) delete process.env.PASTQ_LIBRARY_DIR;
    else process.env.PASTQ_LIBRARY_DIR = previousLibraryDir;
    assert.ok(path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('pastq-seed-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('installs questions, catalog entry and every referenced diagram on a fresh disk', () => {
    const { bundle, installed } = seeds.installLibrarySeeds();
    assert.equal(installed, true);
    assert.equal(bundle.title, 'Chemistry Remix');
    assert.equal(bundle.questions.length, 1899);
    assert.equal(store.listBundles().length, 1);
    const materials = store.getCatalog().organizations.flatMap(org => org.examTypes.flatMap(exam => exam.materials));
    assert.equal(materials.length, 1);
    assert.equal(materials[0].bundleId, bundle.id);
    assert.equal(materials[0].questionCount, 1899);
    const figures = bundle.questions.flatMap(question => question.figures || []).filter(figure => figure.file);
    assert.equal(new Set(figures.map(figure => figure.file)).size, 121);
    for (const figure of figures) {
      const asset = path.join(dataDir, 'pages', ...figure.url.split('/').slice(-2, -1), 'figures', figure.file);
      assert.ok(fs.statSync(asset).size > 0, figure.file);
    }
  });

  it('preserves reviewed answers, edited figures and catalog data on repeated startup', () => {
    const { bundle } = seeds.installLibrarySeeds();
    bundle.questions[0].explanation = 'Teacher-reviewed explanation';
    store.saveBundle(bundle);
    const figure = bundle.questions.flatMap(question => question.figures || []).find(item => item.file);
    const asset = path.join(dataDir, 'pages', 'chem-run3', 'figures', figure.file);
    fs.writeFileSync(asset, 'reviewed figure');
    const catalogBefore = fs.readFileSync(path.join(dataDir, 'library', 'catalog.json'), 'utf8');
    assert.equal(seeds.installLibrarySeeds().installed, false);
    assert.equal(store.getBundle(bundle.id).questions[0].explanation, 'Teacher-reviewed explanation');
    assert.equal(fs.readFileSync(asset, 'utf8'), 'reviewed figure');
    assert.equal(fs.readFileSync(path.join(dataDir, 'library', 'catalog.json'), 'utf8'), catalogBefore);
    assert.equal(store.listBundles().length, 1);
  });

  it('rebuilds a missing catalog without replacing the existing bundle', () => {
    const { bundle } = seeds.installLibrarySeeds();
    bundle.questions[0].explanation = 'Keep this correction';
    store.saveBundle(bundle);
    fs.unlinkSync(path.join(dataDir, 'library', 'catalog.json'));
    assert.equal(seeds.installLibrarySeeds().installed, false);
    assert.equal(store.getBundle(bundle.id).questions[0].explanation, 'Keep this correction');
    assert.equal(store.getCatalog().organizations.length, 1);
  });

  it('retains separate subject collections by one publisher without dropping repeated questions', () => {
    const meta = { taxonomyVersion: 2, groupingStatus: 'grouped', groupKey: 'jamb',
      organization: { name: 'JAMB', type: 'exam_board' }, exam: { name: 'UTME' }, publisher: { name: 'TestDriller' } };
    const questions = [{ question: 'The same printed question', options: ['A', 'B'], correct: 0 },
      { question: 'The same printed question', options: ['B', 'A'], correct: 1 }];
    for (const subject of ['biology', 'physics']) {
      const bundle = { id: `utme-${subject}`, title: subject, questions, libraryMeta: { ...meta, collectionKey: subject } };
      assert.equal(store.installSeedBundle(bundle).installed, true);
      assert.equal(store.installSeedBundle(bundle).installed, false);
      assert.equal(store.getBundle(bundle.id).questions.length, 2);
    }
    const materials = store.getCatalog().organizations[0].examTypes[0].materials;
    assert.deepEqual(materials.map(item => item.bundleId).sort(), ['utme-biology', 'utme-physics']);
  });
});
