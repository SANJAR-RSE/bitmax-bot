import test from 'node:test';
import assert from 'node:assert/strict';

import { encryptSecret, decryptSecret, isEncrypted, randomToken } from './crypto';

test('a credential survives an encrypt/decrypt round trip', () => {
  for (const secret of [
    'p@ssw0rd!',
    'user@example.com',
    'парол 123',
    "o'zbek belgilari: ø ü ğ",
    'a'.repeat(2000),
  ]) {
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  }
});

test('encrypting the same value twice produces different ciphertext', () => {
  // A fresh nonce per call means an attacker with the database cannot tell that two sellers
  // listed accounts with the same password.
  const a = encryptSecret('same-password');
  const b = encryptSecret('same-password');

  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('empty values pass through untouched', () => {
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');
});

test('plaintext written before encryption existed is returned as-is', () => {
  // Lets an existing database keep working while the migration backfills.
  assert.equal(decryptSecret('legacy_plaintext_password'), 'legacy_plaintext_password');
  assert.equal(isEncrypted('legacy_plaintext_password'), false);
  assert.equal(isEncrypted(encryptSecret('x')), true);
});

test('a tampered ciphertext fails loudly instead of returning garbage', () => {
  // GCM's auth tag is the point: a modified record must not decrypt to something we would
  // then hand to a buyer as their login.
  const valid = encryptSecret('correct-password');
  const parts = valid.split(':');
  const flipped = Buffer.from(parts[3], 'base64');
  flipped[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64')].join(':');

  assert.throws(() => decryptSecret(tampered), /could not be decrypted/);
});

test('reveal tokens are URL-safe and unique', () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const token = randomToken(16);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    tokens.add(token);
  }
  assert.equal(tokens.size, 100);
});
