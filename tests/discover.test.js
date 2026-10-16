import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import * as store from '../services/discover/store.js';
function isolated(t) {
  store.closeDiscoverStore(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-discover-')); process.env.DATA_DIR = dir;
  t.after(() => { store.closeDiscoverStore(); if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pastq-discover-')) throw new Error('Unexpected test directory'); fs.rmSync(dir, { recursive: true, force: true }); });
}
test('public discovery never exposes private sessions or invite secrets', t => {
  isolated(t);
  const published = store.publishSession('tutor', { title: 'Chemistry revision', kind: 'tutorial', visibility: 'public', tag: 'JAMB' });
  const hidden = store.publishSession('tutor', { title: 'Private Biology class', kind: 'exam', visibility: 'private' });
  assert.equal(hidden.inviteCode.length, 16); assert.equal(published.inviteCode, undefined);
  assert.deepEqual(store.publicSessions('student').map(item => item.id), [published.session.id]);
  assert.equal(store.publicSessions('student', 'biology').length, 0);
  assert.equal(JSON.stringify(store.publicSessions('student')).includes(hidden.inviteCode), false);
  assert.throws(() => store.joinPublicSession('student', hidden.session.id), error => error.status === 404);
  const joined = store.joinPrivateSession('student', hidden.inviteCode.toLowerCase().match(/.{1,4}/g).join('-'));
  assert.equal(joined.joined, true); assert.equal(joined.id, hidden.session.id);
  store.joinPrivateSession('student', hidden.inviteCode); assert.equal(store.joinedSessions('student').length, 1); assert.equal(store.joinedSessions('other-student').length, 0);
  assert.equal(JSON.stringify(store.joinedSessions('student')).includes('code_hash'), false);
});
test('memberships persist across restart and ended sessions cannot be joined', t => {
  isolated(t); const { session } = store.publishSession('tutor', { title: 'Maths mock', kind: 'exam', visibility: 'public' });
  store.joinPublicSession('student', session.id); store.closeDiscoverStore(); assert.equal(store.joinedSessions('student')[0].id, session.id);
  assert.throws(() => store.endSession('another-tutor', session.id), error => error.status === 404);
  store.endSession('tutor', session.id); assert.equal(store.publicSessions('student').length, 0);
  assert.throws(() => store.joinPublicSession('new-student', session.id), error => error.status === 409);
  for (const input of [{ title: 'x', kind: 'exam', visibility: 'public' }, { title: 'A paper', kind: 'invalid', visibility: 'public' }, { title: 'A paper', kind: 'exam', visibility: 'public', logo: 'javascript:alert(1)' }]) assert.throws(() => store.publishSession('tutor', input));
});
test('student API requires sign-in, blocks publishing and scopes private memberships', async t => {
  isolated(t); process.env.NODE_ENV = 'test'; process.env.AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT = 'false'; process.env.SESSION_OWNER_HMAC_SECRET = 'discover-test-key';
  const provider = http.createServer((req, res) => {
    const user = req.headers.authorization?.replace('Bearer ', ''); res.setHeader('Content-Type', 'application/json');
    if (!['student-a', 'student-b', 'tutor-admin'].includes(user)) { res.writeHead(401); res.end('{}'); }
    else res.end(JSON.stringify({ id: user, email: `${user}@example.test`, user_metadata: {}, app_metadata: user === 'tutor-admin' ? { role: 'admin' } : {} }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); process.env.SUPABASE_URL = `http://127.0.0.1:${provider.address().port}`; process.env.SUPABASE_ANON_KEY = 'placeholder';
  const { default: routes } = await import('../routes/discover.js'); const app = express(); app.use(express.json()); app.use('/api/discover', routes);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); });
  const url = `http://127.0.0.1:${server.address().port}/api/discover`;
  const call = (suffix, user = 'student-a', method = 'GET', body) => fetch(url + suffix, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(url)).status, 401);
  const input = { title: 'Private UTME tutorial', visibility: 'private', kind: 'tutorial' };
  assert.equal((await call('', 'student-a', 'POST', input)).status, 403);
  const create = await call('', 'tutor-admin', 'POST', input); assert.equal(create.status, 201); const created = await create.json();
  assert.equal((await (await call('')).json()).sessions.length, 0);
  assert.equal((await call(`/${created.session.id}/join`, 'student-a', 'POST', {})).status, 404);
  assert.equal((await call('/join', 'student-a', 'POST', { code: 'wrong' })).status, 400);
  assert.equal((await call('/join', 'student-a', 'POST', { code: created.inviteCode })).status, 200);
  assert.equal((await (await call('')).json()).joined.length, 1); assert.equal((await (await call('', 'student-b')).json()).joined.length, 0);
  assert.equal((await call(`/${created.session.id}/end`, 'student-a', 'POST', {})).status, 403);
});
