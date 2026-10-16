import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('authenticated review API saves once and prevents another student reading or changing it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-route-'));
  process.env.DATA_DIR = root;
  process.env.NODE_ENV = 'test';
  delete process.env.AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT;
  process.env.SESSION_OWNER_HMAC_SECRET = 'route-test-owner-key';
  const provider = http.createServer((req, res) => {
    const id = req.headers.authorization?.replace('Bearer ', '');
    res.setHeader('Content-Type', 'application/json');
    if (!['student-a', 'student-b'].includes(id)) { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ id, email: `${id}@example.com`, app_metadata: {}, user_metadata: {} }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${provider.address().port}`;
  process.env.SUPABASE_ANON_KEY = 'test-placeholder';
  const { default: routes } = await import('../routes/vision.js');
  const { createSession, saveSession } = await import('../services/vision/store.js');
  const { closeReviewedMaterials } = await import('../services/vision/reviewedMaterialStore.js');
  const app = express(); app.use(express.json()); app.use('/api/vision', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/vision`;
  const question = { id: 1, subject: 'Physics', question: 'What is force?', options: ['First', 'Second'], correct: 1 };
  const ownerKey = crypto.createHmac('sha256', process.env.SESSION_OWNER_HMAC_SECRET).update('student-a').digest('base64url');
  const session = createSession({ id: 'private-paper', name: 'Physics paper', ownerKey });
  Object.assign(session, { status: 'completed', questions: [question] }); saveSession(session);
  const request = (path, user = 'student-a', body) => fetch(base + path, {
    method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await fetch(base + '/materials')).status, 401);
    assert.equal((await request('/sessions/private-paper/confirm', 'student-b', { questions: [question] })).status, 403);
    assert.equal((await request('/sessions/private-paper/confirm', 'student-a', { questions: [] })).status, 400);
    const questions = [{ ...question, question: 'A saved correction?' }];
    for (let i = 0; i < 2; i++) assert.equal((await request('/sessions/private-paper/confirm', 'student-a', { questions })).status, 200);
    const list = await (await request('/materials')).json();
    assert.equal(list.materials.length, 1); assert.equal(list.materials[0].questions, undefined);
    const saved = await (await request('/materials/private-paper')).json();
    assert.equal(saved.questions[0].question, 'A saved correction?');
    assert.equal((await request('/materials/private-paper', 'student-b')).status, 404);
    assert.deepEqual((await (await request('/materials', 'student-b')).json()).materials, []);
  } finally {
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    closeReviewedMaterials(); fs.rmSync(root, { recursive: true, force: true });
  }
});
