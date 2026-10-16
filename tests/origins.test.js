import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginMatcher } from '../services/http/origins.js';

test('exact and wildcard origins', () => {
  const m = createOriginMatcher('https://pastq.app, https://pastq-*.vercel.app/');
  assert.equal(m.configured, true);
  assert.equal(m.allowsAny, false);
  assert.equal(m.allows('https://pastq.app'), true);
  assert.equal(m.allows('https://pastq-abc123-team.vercel.app'), true);
  assert.equal(m.allows('http://pastq-abc.vercel.app'), false);
  assert.equal(m.allows('https://pastq-a.b.vercel.app'), false);
  assert.equal(m.allows('https://pastq-x.vercel.app.evil.com'), false);
  assert.equal(m.allows('https://evilpastq-x.vercel.app'), false);
});

test('empty and star lists', () => {
  assert.equal(createOriginMatcher('').configured, false);
  assert.equal(createOriginMatcher('*').allowsAny, true);
});
