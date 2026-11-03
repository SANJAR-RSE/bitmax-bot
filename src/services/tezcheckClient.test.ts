import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { isLivePaid, requestSignature, statusSchema, toMinor, verifyWebhook } from './tezcheckClient';

test('UZS conversion rejects fractional/unsafe amounts', () => {
  assert.equal(toMinor(150000), 15000000);
  for (const n of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => toMinor(n));
});
test('request signature uses exact bytes and the full path', () => {
  const raw = '{"title":"O‘zbek / test", "amount_minor":100000}';
  const expected = 'v1=' + crypto.createHmac('sha256', 'key').update('1786000000.POST./api/merchant/v1/bills.' + crypto.createHash('sha256').update(raw).digest('hex')).digest('hex');
  assert.equal(requestSignature('key', '1786000000', 'POST', '/api/merchant/v1/bills', raw), expected);
});
test('webhook verifies raw bytes, rotation signatures, version, delivery and timestamp', () => {
  const raw = Buffer.from('{"id":"oev_1", "type":"payment.succeeded"}');
  const now = 1786000000000;
  const sig = 'v1=' + crypto.createHmac('sha256', 'secret').update('1786000000.whd_1.').update(raw).digest('hex');
  assert.equal(verifyWebhook(raw, '1786000000', 'whd_1', `v1=${'0'.repeat(64)}, ${sig}`, 'secret', now), true);
  assert.equal(verifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), '1786000000', 'whd_1', sig, 'secret', now), false);
  assert.equal(verifyWebhook(raw, '1786000000', 'whd_2', sig, 'secret', now), false);
  assert.equal(verifyWebhook(raw, '1786000000', 'whd_1', sig.replace('v1=', 'v2='), 'secret', now), false);
  assert.equal(verifyWebhook(raw, '1786000000', 'whd_1', sig, 'secret', now + 301000), false);
  assert.equal(verifyWebhook(raw, 'bad', 'whd_1', sig, 'secret', now), false);
  assert.equal(verifyWebhook(raw, '1786000000', 'whd_1', sig, '', now), false);
});
test('only matching live succeeded payment funds an order; bill state alone never does', () => {
  const data = statusSchema.parse({ bill: { id: 'link_1', external_reference: 'order1', amount_minor: 15000000,
    currency: 'UZS', state: 'expired', paid: true, environment: 'live', livemode: true },
    payment: { id: 'pay_1', state: 'succeeded', amount_minor: 15000000, fee_minor: 150000, net_minor: 14850000,
      refunded_amount_minor: 0, currency: 'UZS', environment: 'live', livemode: true } });
  const expected = { id: 'link_1', reference: 'order1', amountMinor: 15000000 };
  assert.equal(isLivePaid(data, expected), true);
  assert.equal(isLivePaid({ ...data, bill: { ...data.bill, paid: false } }, expected), false);
  assert.equal(isLivePaid({ ...data, payment: { ...data.payment!, environment: 'test' } }, expected), false);
  assert.equal(isLivePaid({ ...data, payment: { ...data.payment!, problem: { unknown_reason: 'timeout' } } }, expected), false);
  assert.throws(() => isLivePaid(data, { ...expected, reference: 'different-order' }));
  assert.throws(() => isLivePaid({ ...data, payment: { ...data.payment!, net_minor: 1 } }, expected));
});

test('an unpaid live-provider bill may have no environment yet', () => {
  const data = statusSchema.parse({ bill: { id: 'link_unpaid', external_reference: 'order-unpaid', amount_minor: 100000,
    currency: 'UZS', state: 'active', paid: false, environment: null, livemode: false }, payment: null });
  assert.equal(isLivePaid(data, { id: 'link_unpaid', reference: 'order-unpaid', amountMinor: 100000 }), false);
});
