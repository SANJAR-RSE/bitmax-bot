import assert from 'node:assert/strict';
import crypto from 'crypto';
import { test } from 'node:test';
import { config } from '../config';
import { HamyonDuplicateAmountError, hamyonClient, hamyonSign, verifyHamyonSign } from './hamyonClient';

function withFetch(status: number, body: unknown, run: (calls: { url: string; init: any }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return run(calls).finally(() => { globalThis.fetch = real; });
}

test('the callback signature follows the documented formula', () => {
  const expected = crypto.createHash('md5').update('12a1b2c350000sk_x').digest('hex');
  assert.equal(hamyonSign('12', 'a1b2c3', '50000', 'sk_x'), expected);
  const input = { shopId: '12', paymentId: 'a1b2c3', amount: '50000', sign: expected };
  assert.equal(verifyHamyonSign(input, 'sk_x'), true);
  assert.equal(verifyHamyonSign({ ...input, sign: expected.toUpperCase() }, 'sk_x'), true);
  assert.equal(verifyHamyonSign({ ...input, amount: '50001' }, 'sk_x'), false);
  assert.equal(verifyHamyonSign({ ...input, sign: 'short' }, 'sk_x'), false);
  assert.equal(verifyHamyonSign(input, ''), false);
});

test('creating a payment sends form fields and normalises the card', async () => {
  config.hamyon.shopId = '12';
  config.hamyon.shopKey = 'sk_x';
  await withFetch(200, { payment_id: 'p1', amount: 50000, card: '8600 1234 5678 9012', expire_at: 1767225600 }, async (calls) => {
    const payment = await hamyonClient.createPayment(50000, 'order-1');
    assert.equal(payment.paymentId, 'p1');
    assert.equal(payment.card, '8600123456789012');
    assert.equal(payment.expireAt.getTime(), 1767225600000);
    assert.equal(calls[0].url, 'https://hamyon-api.uz/payment/create');
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get('shop_id'), '12');
    assert.equal(form.get('amount'), '50000');
    assert.equal(form.get('order_id'), 'order-1');
  });
});

test('a different amount in the reply is refused', async () => {
  await withFetch(200, { payment_id: 'p1', amount: 49000, card: '8600', expire_at: 1 }, async () => {
    await assert.rejects(() => hamyonClient.createPayment(50000, 'order-1'), /different amount/);
  });
});

test('an open payment for the same amount is reported distinctly', async () => {
  await withFetch(400, { error: 'Bu summada ochiq to‘lov mavjud' }, async () => {
    await assert.rejects(() => hamyonClient.createPayment(50000, 'order-1'), HamyonDuplicateAmountError);
  });
});

test('an unknown status is rejected rather than treated as unpaid', async () => {
  await withFetch(200, { payment_id: 'p1', amount: 50000, status: 'paid' }, async () => {
    assert.equal((await hamyonClient.getStatus('p1')).status, 'paid');
  });
  await withFetch(200, { payment_id: 'p1', amount: 50000, status: 'weird' }, async () => {
    await assert.rejects(() => hamyonClient.getStatus('p1'));
  });
});
