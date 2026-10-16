import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authInput } from '../services/auth/validation.js';
import { rateLimit, securityHeaders } from '../services/http/security.js';
test('preserves plus emails, apostrophes, accents and international names', () => {
  const input = authInput({ email: ' ada+study@example.com ', password: 'strong password', name: " Adé O’Connor 🧑🏽‍🎓 " }, { signup: true });
  assert.equal(input.email, 'ada+study@example.com'); assert.equal(input.name, 'Adé O’Connor 🧑🏽‍🎓');
  assert.equal(input.password, 'strong password');
});
test('rejects malformed credentials, large fields and short new passwords on the server', () => {
  for (const body of [{ email: {}, password: 'password123', name: 'Ada' }, { email: 'a@b.com', password: 'short', name: 'Ada' }, { email: 'a@b.com', password: 'password123', name: 'a'.repeat(121) }]) {
    assert.throws(() => authInput(body, { signup: true }));
  }
  assert.doesNotThrow(() => authInput({ email: 'a@b.com', password: 'old123' }));
});
test('throttles repeated requests with retry guidance without account lockout', () => {
  const headers = {}; let status; let calls = 0;
  const response = { set: (key, value) => { headers[key] = value; }, status: code => { status = code; return response; }, json: body => body };
  const limit = rateLimit({ limit: 2, keyPrefix: 'auth-test' });
  for (let i = 0; i < 3; i++) limit({ ip: 'test-ip' }, response, () => calls++);
  assert.equal(calls, 2); assert.equal(status, 429); assert.ok(Number(headers['Retry-After']) > 0);
});
test('adds browser security headers', () => {
  let headers; securityHeaders({}, { set: value => { headers = value; } }, () => {});
  assert.equal(headers['X-Content-Type-Options'], 'nosniff'); assert.equal(headers['X-Frame-Options'], 'DENY');
});
