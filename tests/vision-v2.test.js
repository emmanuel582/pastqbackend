import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import sharp from 'sharp';

// Isolate all session/page/library files in temp dirs before any store import.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-v3-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PASTQ_LIBRARY_DIR = path.join(DATA_DIR, 'library');
process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
process.env.VISION_MODEL = 'test/vision-model';

const { validatePageResult, validateStructure } = await import('../services/vision/contract.js');
const { toStoredResult } = await import('../services/vision/pageVision.js');
const { buildNodes, applySections } = await import('../services/vision/structure.js');
const { assembleSession } = await import('../services/vision/assemble.js');
const { cropRegion } = await import('../services/vision/figures.js');
const pageStore = await import('../services/vision/pageStore.js');
const scheduler = await import('../services/vision/scheduler.js');

const q = (o) => ({
  label: '1', headingRef: 'carried', type: 'single_choice', instruction: null, passage: null, stem: 'Stem?',
  options: [{ letter: 'A', text: 'one' }, { letter: 'B', text: 'two' }, { letter: 'C', text: 'three' }, { letter: 'D', text: 'four' }],
  parts: [], marks: null, answer: null, year: null, sourceRef: null, topic: null, subject: 'Physics', figures: [], legibility: 'clear', unclear: [],
  continuesFromPreviousPage: false, continuesOnNextPage: false, confidence: 0.95, ...o,
});
const h = (ref, printedHeading, kind = 'questions', o = {}) => ({ ref, printedHeading, kind, year: null, topic: null, subject: null, paperLabel: null, ...o });
const inv = (o) => ({ questions: (o.questions || []).map((x) => x.label).filter((l) => l != null), answers: (o.answers || []).map((x) => x.label), explanations: (o.explanations || []).map((x) => x.label) });
const page = (o = {}) => ({ inventory: inv(o), pageType: 'questions', legibility: 'clear', runningHeader: null, headings: [], pageIssues: [], questions: [], answers: [], explanations: [], figuresConfirmed: false, ...o });

describe('page contract', () => {
  it('accepts a clean page', () => {
    assert.deepEqual(validatePageResult(page({ headings: [h('h1', 'Cell Biology')], questions: [q({ headingRef: 'h1' })] }), { sourceKind: 'image' }), []);
  });

  it('rejects impossible output instead of defaulting it', () => {
    const errors = validatePageResult(page({
      runningHeader: 'CHEMISTRY',
      headings: [h('h2', 'Gases'), h('h1', 'CHEMISTRY')],
      questions: [
        q({ label: '1.', headingRef: 'h1', answer: { letters: ['E'], text: null } }),
        q({ label: '2', headingRef: 'h9' }),
        q({ label: '3', headingRef: 'carried', stem: 'The [ILLEGIBLE] of a cell', legibility: 'clear' }),
        q({ label: '5', headingRef: 'h1', figures: [{ bbox: [500, 10, 100, 20], kind: 'diagram', caption: null, description: '' }] }),
      ],
    }), { sourceKind: 'image' });
    const has = (s) => assert.ok(errors.some((e) => e.includes(s)), `${s}\n${errors.join('\n')}`);
    has('refs must be h1, h2');
    has('repeats the runningHeader');
    has('bare identifier');
    has('not among the option letters');
    has('"h9" is not one of');
    has('comes after an item under');
    has('legibility is "clear" but');
    has('x1 > x0');
    has('description is required');
  });

  it('accepts every question type, not only multiple choice', () => {
    const r = page({ questions: [
      q({ label: '1', type: 'essay', options: [], parts: [{ label: 'a', text: 'Define osmosis.', marks: 2 }], marks: 6 }),
      q({ label: '2', type: 'fill_in_blank', options: [], stem: 'The SI unit of force is ____.', answer: { letters: [], text: 'newton' } }),
      q({ label: '3', type: 'true_false', options: [{ letter: 'T', text: 'True' }, { letter: 'F', text: 'False' }] }),
    ] });
    assert.deepEqual(validatePageResult(r, { sourceKind: 'image' }), []);
    assert.equal(toStoredResult(r, 1).questions[1].answerText, 'newton');
  });
});

describe('structure from per-page headings', () => {
  const pages = [0, 1, 2].map((i) => ({ id: `p${i}`, index: i, status: 'done' }));
  const results = new Map([
    ['p0', toStoredResult(page({ questions: [q({ label: '1' })] }), 1)],
    ['p1', toStoredResult(page({ headings: [h('h1', 'Gases')], questions: [q({ label: '2', headingRef: 'carried' }), q({ label: '1', headingRef: 'h1' })] }), 2)],
    ['p2', toStoredResult(page({ headings: [h('h1', 'Answers', 'answer_key')], questions: [q({ label: '2', headingRef: 'carried' })], answers: [{ headingRef: 'h1', label: '1', letters: ['B'], text: null }] }), 3)],
  ]);

  it('builds ordered nodes; carried items join the open node, early ones a start node', () => {
    const { nodes, nodeOf } = buildNodes(pages, results);
    assert.deepEqual(nodes.map((n) => n.id), ['start', 'p1:h1', 'p2:h1']);
    assert.equal(nodeOf('p0', 'carried'), 'start');
    assert.equal(nodeOf('p1', 'carried'), 'start');
    assert.equal(nodeOf('p2', 'carried'), 'p1:h1');
    assert.deepEqual(nodes[1].items.questions, ['1', '2']);
  });

  it('validates that the model covers every node once, in order, with real links', () => {
    const sec = (o) => ({ continuesPrevious: false, year: null, topic: null, subject: null, paperLabel: null, answersFor: [], unlinkedReason: null, ...o });
    const errors = validateStructure({ organizedBy: 'topic', documentTitle: null, sections: [
      sec({ localKey: 'a', nodes: ['start'], title: 'Intro', kind: 'questions' }),
      sec({ localKey: 'k', nodes: ['p2:h1'], title: 'Answers', kind: 'answer_key' }),
    ] }, { nodeIds: ['start', 'p1:h1', 'p2:h1'], earlierQuestionIds: [], hasOpen: false });
    assert.ok(errors.some((e) => e.includes('missing: p1:h1')));
    assert.ok(errors.some((e) => e.includes('link it to the question section')));
  });

  it('tags every item with its section and assembles in document order', () => {
    const outline = {
      organizedBy: 'topic',
      sections: [
        { id: 's1', title: 'Kinetic theory', kind: 'questions', nodes: ['start'], answersFor: [], pageStart: 1, pageEnd: 2 },
        { id: 's2', title: 'Gases', kind: 'questions', nodes: ['p1:h1'], answersFor: [], pageStart: 2, pageEnd: 3 },
        { id: 's3', title: 'Answers', kind: 'answer_key', nodes: ['p2:h1'], answersFor: ['s2'], pageStart: 3, pageEnd: 3 },
      ],
      nodeToSection: { start: 's1', 'p1:h1': 's2', 'p2:h1': 's3' },
    };
    const out = assembleSession({ id: 'x', pages, outline, questionIdByKey: {} }, applySections(pages, results, outline));
    assert.deepEqual(out.groups.map((g) => [g.title, g.count]), [['Kinetic theory', 2], ['Gases', 2]]);
    assert.equal(out.questions.find((x) => x.sectionId === 's2' && x.questionNumber === '1').correct, 1, 'answer key applied to Gases Q1 only');
    assert.equal(out.questions.find((x) => x.sectionId === 's1' && x.questionNumber === '1').correct, null);
  });
});

describe('page store', () => {
  it('claims pages atomically and shifts indices for insertion', () => {
    const sid = 'store-test-0001';
    pageStore.addPages(sid, [0, 1, 2].map((i) => ({ id: `${sid}-${i}`, index: i, status: 'pending' })));
    const a = pageStore.claimPending(sid, 2);
    const b = pageStore.claimPending(sid, 2);
    assert.deepEqual(a.map((p) => p.index), [0, 1]);
    assert.deepEqual(b.map((p) => p.index), [2]);
    assert.equal(pageStore.claimPending(sid, 2).length, 0);
    pageStore.shiftIndices(sid, 1, 2);
    assert.deepEqual(pageStore.listPages(sid).map((p) => p.index), [0, 3, 4]);
    assert.equal(pageStore.nextIndex(sid), 5);
    assert.equal(pageStore.requeue(sid, ['processing']), 3);
    pageStore.deleteSessionPages(sid);
  });
});

describe('scheduler', () => {
  it('cuts concurrency on rate limits and grows it back on success', () => {
    const before = scheduler.schedulerStats().limit;
    scheduler.recordRateLimit(0);
    const cut = scheduler.schedulerStats().limit;
    assert.ok(cut < before);
    for (let i = 0; i < 20; i++) scheduler.recordSuccess();
    assert.ok(scheduler.schedulerStats().limit > cut);
  });
});

describe('figures', () => {
  it('crops exactly the confirmed box', async () => {
    const file = path.join(DATA_DIR, 'fig.png');
    await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#fff' } }).png().toFile(file);
    const crop = await cropRegion(file, [100, 100, 600, 300]);
    assert.deepEqual(crop.rect, { left: 100, top: 200, width: 500, height: 400 });
    await assert.rejects(() => cropRegion(file, [0, 0, 0.5, 0.5]), /four integers/);
  });
});

describe('pipeline end-to-end (fake OpenRouter)', () => {
  let server;
  const calls = { pageTurns: 0, zoom: 0, repairs: 0, figureChecks: 0, structure: 0, library: 0 };

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return res.end(JSON.stringify({ data: [{ id: 'test/vision-model', context_length: 1000000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs', 'response_format', 'tools'], top_provider: { max_completion_tokens: 65536 }, pricing: { prompt: '0.0000001', completion: '0.0000002' } }] }));
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const json = JSON.parse(body);
        const reply = (message) => res.end(JSON.stringify({ model: json.model, usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
        const submit = (result, id = 'c1') => reply({ content: '', tool_calls: [{ id, type: 'function', function: { name: 'submit', arguments: JSON.stringify({ result }) } }] });
        const schemaName = json.response_format?.json_schema?.name;

        if (schemaName === 'document_structure') {
          calls.structure += 1;
          const sec = (o) => ({ continuesPrevious: false, year: null, subject: 'Physics', paperLabel: null, answersFor: [], unlinkedReason: null, ...o });
          return reply({ content: JSON.stringify({ organizedBy: 'topic', documentTitle: 'Physics past questions', sections: [
            sec({ localKey: 'm', nodes: ['pg0:h1'], title: 'Motion', kind: 'questions', topic: 'Motion' }),
            sec({ localKey: 'e', nodes: ['pg2:h1'], title: 'Electricity', kind: 'questions', topic: 'Electricity' }),
            sec({ localKey: 'k', nodes: ['pg3:h1'], title: 'Answers: Electricity', kind: 'answer_key', topic: null, answersFor: ['e'] }),
          ] }) });
        }
        if (schemaName === 'library_classification') {
          calls.library += 1;
          return reply({ content: JSON.stringify({ catalogGroup: 'Physics', canonicalSubjects: [{ label: 'physics', canonical: 'Physics' }], streams: ['science'], educationLevel: null }) });
        }
        if (json.tools) {
          calls.pageTurns += 1;
          const n = Number(/^Page (\d+)/.exec(json.messages[1].content.find((p) => p.type === 'text').text)[1]);
          const lastTool = [...json.messages].reverse().find((m) => m.role === 'tool');
          const fig = { bbox: [100, 100, 600, 400], kind: 'circuit', caption: 'Fig. 1', description: 'Two 2-ohm resistors in series with a 6 V cell' };
          const motion = [h('h1', 'MOTION', 'questions', { topic: 'Motion' })];
          if (n === 1) return submit(page({ runningHeader: 'PHYSICS', headings: motion, questions: [q({ label: '1', headingRef: 'h1', stem: 'Velocity is', subject: 'physics', year: '1994', sourceRef: '1994:Q1' }), q({ label: '2', headingRef: 'h1', stem: 'Acceleration is', subject: 'physics', options: [{ letter: 'A', text: 'rate of change of velocity' }], continuesOnNextPage: true })] }));
          if (n === 2) return submit(page({ runningHeader: 'PHYSICS', questions: [q({ label: null, stem: '', subject: 'physics', options: [{ letter: 'B', text: 'speed' }, { letter: 'C', text: 'mass' }], continuesFromPreviousPage: true }), q({ label: '3', stem: 'Momentum is', subject: 'physics' })] }));
          if (n === 4) return submit(page({ pageType: 'answer_key', headings: [h('h1', 'ANSWERS', 'answer_key')], answers: [{ headingRef: 'h1', label: '1', letters: ['b'], text: null }] }));
          const elec = [h('h1', 'ELECTRICITY', 'questions', { topic: 'Electricity' })];
          const p3 = (o) => page({ headings: elec, legibility: 'partial', ...o });
          const circuit = (o) => q({ label: '1', headingRef: 'h1', stem: 'The resistance of the [ILLEGIBLE] shown is', subject: 'physics', figures: [fig], ...o });
          if (!lastTool) { calls.zoom += 1; return reply({ content: '', tool_calls: [{ id: 'z1', type: 'function', function: { name: 'zoom', arguments: JSON.stringify({ bbox: [0, 600, 500, 1000] }) } }] }); }
          if (lastTool.content.startsWith('Zoomed')) return submit(p3({ questions: [circuit()] }), 'c2');
          if (lastTool.content.startsWith('Rejected')) { calls.repairs += 1; return submit(p3({ questions: [circuit({ legibility: 'partial', unclear: [{ bbox: [200, 700, 300, 740], note: 'smudged word' }] })] }), 'c3'); }
          if (lastTool.content.startsWith('Crops of your')) { calls.figureChecks += 1; return submit(p3({ figuresConfirmed: true, questions: [circuit({ legibility: 'partial', unclear: [{ bbox: [200, 700, 300, 740], note: 'smudged word' }] })] }), 'c4'); }
        }
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: `unexpected request ${schemaName}` } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('transcribes pages, maps structure from headings, assembles by topic, publishes', async () => {
    const { createSession, getSession, pageDir } = await import('../services/vision/store.js');
    const { runSessionWorker } = await import('../services/vision/processor.js');
    const session = createSession({ id: 'e2e-session-0001', name: 'Physics' });
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const imagePath = path.join(pageDir(session.id), `page-${i}.jpg`);
      await sharp({ create: { width: 800, height: 1100, channels: 3, background: '#fff' } }).jpeg().toFile(imagePath);
      pages.push({ id: `pg${i}`, index: i, status: 'pending', imagePath, source: 'image' });
    }
    pageStore.addPages(session.id, pages);

    await runSessionWorker(session.id);
    const s = getSession(session.id);

    assert.equal(s.status, 'completed', JSON.stringify(s.followUps));
    assert.equal(calls.zoom, 1);
    assert.equal(calls.repairs, 1, 'invalid submission was sent back with its problems');
    assert.equal(calls.figureChecks, 1, 'figure crops were shown back before acceptance');
    assert.equal(calls.structure, 1);
    assert.equal(s.outline.organizedBy, 'topic');
    assert.deepEqual(s.groups.map((g) => [g.title, g.count]), [['Motion', 3], ['Electricity', 1]]);
    const accel = s.questions.find((x) => x.question === 'Acceleration is');
    assert.deepEqual(accel.options, ['rate of change of velocity', 'speed', 'mass']);
    assert.equal(s.questions.find((x) => x.question === 'Velocity is').sourceRef, '1994:Q1');
    const circuit = s.questions.find((x) => x.sectionId === 's2');
    assert.equal(circuit.correct, 1, 'answer key (lower-case "b") applied by section');
    assert.match(circuit.figures[0].url, /^\/api\/library\/figures\/e2e-session-0001\/p000002-f1-[0-9a-f]{12}\.jpg$/);
    assert.ok(s.followUps.some((f) => f.type === 'unclear_image' && f.message.includes('smudged word')));
    assert.equal(calls.library, 1);
    assert.ok(s.questions.every((x) => x.subject === 'Physics'), 'canonical subject applied');
    assert.ok(s.cost.usd > 0);
    assert.equal(pageStore.statusCounts(session.id).done, 4);
  });

  it('pauses with a clear reason when the model lacks a required capability', async () => {
    const { createSession, getSession } = await import('../services/vision/store.js');
    const { runSessionWorker } = await import('../services/vision/processor.js');
    const { resetModelCache } = await import('../services/vision/modelRegistry.js');
    process.env.VISION_MODEL = 'test/not-listed';
    resetModelCache();
    const session = createSession({ id: 'e2e-session-0002', name: 'x' });
    await runSessionWorker(session.id);
    const s = getSession(session.id);
    assert.equal(s.status, 'paused');
    assert.ok(s.followUps.some((f) => f.message.includes('not listed by OpenRouter')));
    process.env.VISION_MODEL = 'test/vision-model';
    resetModelCache();
  });
});

describe('dispatch during ingest', () => {
  it('starts every page that arrives while earlier pages are still in flight', async () => {
    const want = 8;
    let active = 0;
    let peak = 0;
    const held = [];
    const releaseAll = () => held.splice(0).forEach((fn) => fn());
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return res.end(JSON.stringify({ data: [{ id: 'test/vision-model', context_length: 1000000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs', 'response_format', 'tools'], top_provider: { max_completion_tokens: 65536 }, pricing: { prompt: '0.0000001', completion: '0.0000002' } }] }));
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const json = JSON.parse(body);
        if (!json.tools) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'not under test' } })); }
        const n = /^Page (\d+)/.exec(json.messages[1].content.find((p) => p.type === 'text').text)[1];
        active += 1;
        peak = Math.max(peak, active);
        held.push(() => {
          active -= 1;
          const result = page({ questions: [q({ label: n })] });
          res.end(JSON.stringify({ model: json.model, usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ result }) } }] } }] }));
        });
        if (active >= want) releaseAll();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const previousBase = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const { resetModelCache } = await import('../services/vision/modelRegistry.js');
    resetModelCache();

    const { createSession, pageDir } = await import('../services/vision/store.js');
    const { runSessionWorker, withSessionLock, abortSession } = await import('../services/vision/processor.js');
    const session = createSession({ id: 'e2e-dispatch-0001', name: 'dispatch' });
    await withSessionLock(session.id, (s) => { s.ingest = { status: 'running' }; return s; });
    const addPages = async (from, to) => {
      const pages = [];
      for (let i = from; i < to; i++) {
        const imagePath = path.join(pageDir(session.id), `page-${i}.jpg`);
        await sharp({ create: { width: 400, height: 500, channels: 3, background: '#fff' } }).jpeg().toFile(imagePath);
        pages.push({ id: `dp${i}`, index: i, status: 'pending', imagePath, source: 'pdf' });
      }
      pageStore.addPages(session.id, pages);
    };

    await addPages(0, 2);
    const worker = runSessionWorker(session.id);
    // Wait until the first two pages are in flight, then ingest the rest.
    for (let i = 0; i < 100 && active < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await addPages(2, want);
    await withSessionLock(session.id, (s) => { s.ingest = { status: 'done' }; return s; });
    for (let i = 0; i < 200 && peak < want; i++) await new Promise((r) => setTimeout(r, 50));

    abortSession(session.id);
    releaseAll();
    await Promise.race([worker, new Promise((r) => setTimeout(r, 5000))]);
    server.close();
    process.env.OPENROUTER_BASE_URL = previousBase;
    resetModelCache();
    assert.equal(peak, want, `all ${want} pages should be in flight together (peak was ${peak})`);
  });
});
