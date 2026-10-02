import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { installLibrarySeeds } from '../services/library/seeds.js';
import { getBundle, saveBundle, getCatalog, listBundles } from '../services/library/store.js';
import { libraryFigurePath } from '../services/library/figures.js';
import libraryRoutes from '../routes/library.js';

const materials = () => getCatalog().universities.flatMap(org => org.examTypes.flatMap(exam => exam.manufacturers));

describe('shipped Chemistry Remix', () => {
  let root;
  let previous;
  beforeEach(() => {
    previous = { DATA_DIR: process.env.DATA_DIR, PASTQ_LIBRARY_DIR: process.env.PASTQ_LIBRARY_DIR };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-seed-'));
    process.env.DATA_DIR = root;
    delete process.env.PASTQ_LIBRARY_DIR;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('installs the full bundle, catalog entry and all 121 diagrams on a fresh server', () => {
    const bundle = installLibrarySeeds();
    assert.equal(bundle.title, 'Chemistry Remix');
    assert.equal(bundle.questions.length, 1899);
    assert.equal(bundle.questions.filter(q => q.options?.length >= 2).length, 1894);
    assert.equal(materials().length, 1);
    assert.equal(materials()[0].title, 'Chemistry Remix');
    assert.equal(materials()[0].questionCount, 1899);
    assert.deepEqual(materials()[0].streams, ['science']);
    assert.equal(fs.readdirSync(path.join(root, 'pages', 'chem-run3', 'figures')).length, 121);
    for (const q of bundle.questions) for (const f of q.figures || []) {
      assert.ok(libraryFigurePath('chem-run3', f.file));
    }
  });

  it('preserves reviewed answers, diagrams and catalog timestamps across restarts', () => {
    const bundle = installLibrarySeeds();
    bundle.questions[0].explanation = 'Teacher correction';
    saveBundle(bundle);
    const figure = bundle.questions.flatMap(q => q.figures || [])[0];
    const file = libraryFigurePath('chem-run3', figure.file);
    fs.writeFileSync(file, 'Edited diagram');
    const timestamp = getCatalog().updatedAt;
    installLibrarySeeds();
    assert.equal(listBundles().length, 1);
    assert.equal(getBundle(bundle.id).questions[0].explanation, 'Teacher correction');
    assert.equal(fs.readFileSync(file, 'utf8'), 'Edited diagram');
    assert.equal(getCatalog().updatedAt, timestamp);
  });

  it('rebuilds a missing catalog without overwriting the installed bundle', () => {
    const bundle = installLibrarySeeds();
    bundle.questions[0].explanation = 'Saved correction';
    saveBundle(bundle);
    fs.unlinkSync(path.join(root, 'library', 'catalog.json'));
    installLibrarySeeds();
    assert.equal(materials().length, 1);
    assert.equal(getBundle(bundle.id).questions[0].explanation, 'Saved correction');
    assert.equal(listBundles().length, 1);
  });

  it('returns questions and diagrams through the same API used by the frontend', async () => {
    const bundle = installLibrarySeeds();
    const app = express();
    app.use('/api/library', libraryRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const catalog = await (await fetch(`${origin}/api/library/catalog`)).json();
      const material = catalog.universities[0].examTypes[0].manufacturers[0];
      assert.equal(material.title, 'Chemistry Remix');
      const response = await fetch(`${origin}/api/library/bundles/${material.bundleId}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).questions.length, 1899);
      const figure = bundle.questions.flatMap(q => q.figures || [])[0];
      const image = await fetch(`${origin}${figure.url}`);
      assert.equal(image.status, 200);
      assert.match(image.headers.get('content-type'), /image\/jpeg/);
      assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).slice(0, 2)], [255, 216]);
      assert.equal((await fetch(`${origin}/api/library/figures/chem-run3/not-a-figure.jpg`)).status, 404);
      assert.equal((await fetch(`${origin}/api/library/figures/chem-run3/p999999-f1-000000000000.jpg`)).status, 404);
      assert.equal(libraryFigurePath('../private', figure.file), null);
      assert.equal(libraryFigurePath('chem-run3', '../../.env'), null);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
