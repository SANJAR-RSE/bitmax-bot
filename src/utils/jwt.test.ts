import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from './jwt';

const claims = { sub: '65f0000000000000000000aa', tg: 12345, sid: 'abc123' };

test('a freshly signed session verifies and round-trips its claims', () => {
  const token = signSession(claims, 60);
  const decoded = verifySession(token);
  assert.ok(decoded);
  assert.equal(decoded!.sub, claims.sub);
  assert.equal(decoded!.tg, claims.tg);
  assert.equal(decoded!.sid, claims.sid);
});

test('an expired session is refused', () => {
  assert.equal(verifySession(signSession(claims, -1)), null);
});

test('tampering with the payload invalidates the signature', () => {
  const [head, payload, signature] = signSession(claims, 60).split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  forged.sub = '65f0000000000000000000bb';
  const swapped = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.equal(verifySession(`${head}.${swapped}.${signature}`), null);
});

// The classic JWT downgrade: strip the signature and claim the token needs none.
test('an alg:none token is refused', () => {
  const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 })
  ).toString('base64url');
  assert.equal(verifySession(`${head}.${payload}.`), null);
  assert.equal(verifySession(`${head}.${payload}.anything`), null);
});

test('garbage input never throws, it just fails to verify', () => {
  for (const bad of ['', 'a.b', 'a.b.c', '....', 'null', '{}']) {
    assert.equal(verifySession(bad), null);
  }
});
