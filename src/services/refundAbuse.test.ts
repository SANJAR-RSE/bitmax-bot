import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { EscrowHold } from '../models/EscrowHold';
import { User } from '../models/User';
import { paymentService } from './paymentService';
import { quoteRefund } from './refundEngine';

afterEach(() => mock.restoreAll());

const now = new Date('2026-08-08T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

test('a buyer flagged for refund abuse gets no automatic refund after opening the goods', () => {
  const quote = quoteRefund({ amount: 100_000, boughtAt: minutesAgo(30), revealedAt: minutesAgo(10), now, requiresArbitration: true });
  assert.equal(quote.allowed, false);
  assert.equal(quote.requiresArbitration, true);
  assert.match(quote.message, /admin/);
});

test('the same request from an unflagged buyer is still automatic', () => {
  const quote = quoteRefund({ amount: 100_000, boughtAt: minutesAgo(30), revealedAt: minutesAgo(10), now });
  assert.equal(quote.allowed, true);
  assert.equal(quote.requiresArbitration, false);
});

test('a flagged buyer who never opened the goods is still refunded in full', () => {
  // Nothing was delivered, and the auto-refund job for unopened orders relies on this.
  const quote = quoteRefund({ amount: 100_000, boughtAt: minutesAgo(30), revealedAt: null, now, requiresArbitration: true });
  assert.equal(quote.allowed, true);
  assert.equal(quote.refundToBuyer, 100_000);
});

test('processRefund moves no money for a flagged buyer', async () => {
  const holdId = new mongoose.Types.ObjectId();
  const hold = {
    _id: holdId, status: 'holding', amount: 100_000, buyerId: new mongoose.Types.ObjectId(),
    boughtAt: new Date(Date.now() - 30 * 60_000), credentialsRevealedAt: new Date(Date.now() - 10 * 60_000),
  };
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(User, 'findById', async () => ({ refundAutoDisabled: true }));
  const settle = mock.method(paymentService as any, 'settleEscrow', async () => undefined);

  const result = await paymentService.processRefund(String(holdId), 'Akkaunt ishlamayapti');

  assert.equal(result.allowed, false);
  assert.equal(settle.mock.callCount(), 0, 'escrow must stay in holding for an admin to settle');
});
