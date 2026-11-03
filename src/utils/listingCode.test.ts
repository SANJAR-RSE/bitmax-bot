import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingCodeFromSequence, parseListingCode } from './listingCode';
test('six-digit IDs transition only after numeric exhaustion', () => {
  assert.equal(listingCodeFromSequence(1), '100000');
  assert.equal(listingCodeFromSequence(900000), '999999');
  assert.equal(listingCodeFromSequence(900001), 'A00000');
  assert.equal(listingCodeFromSequence(900001 + 36 ** 5 - 1), 'AZZZZZ');
  assert.equal(listingCodeFromSequence(900001 + 36 ** 5), 'B00000');
  assert.equal(listingCodeFromSequence(900000 + 26 * 36 ** 5), 'ZZZZZZ');
  assert.throws(() => listingCodeFromSequence(900001 + 26 * 36 ** 5));
  for (const n of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => listingCodeFromSequence(n));
});
test('IDs normalize commands and reject malformed input', () => {
  for (const input of ['100000', '#100000', '/id 100000', '/id@bitimax_bot 100000']) assert.equal(parseListingCode(input), '100000');
  assert.equal(parseListingCode('a0000z'), 'A0000Z');
  for (const input of ['12345', '000000', '1000000', '{"$ne":null}', '100000 extra']) assert.equal(parseListingCode(input), null);
});
