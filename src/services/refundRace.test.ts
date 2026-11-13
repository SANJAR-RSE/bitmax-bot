import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { AlreadyProcessedError, paymentService } from './paymentService';

afterEach(() => mock.restoreAll());

const oid = () => new mongoose.Types.ObjectId();
const holding = (revealed: boolean) => ({
  _id: oid(), status: 'holding', amount: 100_000, buyerId: oid(), productId: oid(),
  boughtAt: new Date(Date.now() - 60 * 60_000),
  credentialsRevealedAt: revealed ? new Date(Date.now() - 5 * 60_000) : undefined,
});

test('credentials are not handed out once the order was refunded in the meantime', async () => {
  const hold = holding(false);
  mock.method(EscrowHold, 'findById', async () => hold); // snapshot: still "holding"
  const claim = mock.method(EscrowHold, 'findOneAndUpdate', async () => null); // but it no longer is
  const product = mock.method(Product, 'findById', async () => ({ getCredentials: () => ({ login: 'x', password: 'y' }) }));

  await assert.rejects(paymentService.revealCredentials(String(hold._id), String(hold.buyerId)), AlreadyProcessedError);
  assert.ok(claim.mock.callCount() > 0);
  for (const call of claim.mock.calls) assert.equal((call.arguments as any[])[0].status, 'holding');
  assert.equal(product.mock.callCount(), 0, 'no credentials decrypted');
});

test('the unopened-order auto-refund stands down if the buyer opened it meanwhile', async () => {
  const hold = holding(true); // opened after the job took its snapshot
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(User, 'findById', async () => ({ refundAutoDisabled: false }));
  const settle = mock.method(paymentService as any, 'settleEscrow', async () => undefined);

  const result = await paymentService.processRefund(String(hold._id), 'auto', undefined, { onlyIfUnopened: true });

  assert.equal(result.allowed, false);
  assert.equal(settle.mock.callCount(), 0);
});

test('a refund only settles if the reveal state is still the one it was priced on', async () => {
  const hold = holding(false);
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(User, 'findById', async () => ({ refundAutoDisabled: false }));
  const settle = mock.method(paymentService as any, 'settleEscrow', async () => undefined);

  await paymentService.processRefund(String(hold._id), 'Boshqa sabab');

  const opts = (settle.mock.calls[0].arguments as any[])[1];
  assert.equal(opts.buyerAmount, 100_000);
  assert.deepEqual(opts.claimFilter, { credentialsRevealedAt: { $exists: false } });
});

test('refunding an order that was never opened does not count toward refund abuse', async () => {
  const hold = holding(false);
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(User, 'findById', async () => ({ refundAutoDisabled: false }));
  mock.method(paymentService as any, 'settleEscrow', async () => undefined);
  const counted = mock.method(paymentService as any, 'recordBuyerRefund', async () => undefined);

  await paymentService.processRefund(String(hold._id), 'auto');
  assert.equal(counted.mock.callCount(), 0);
});

test('refunding after opening the goods still counts toward refund abuse', async () => {
  const hold = holding(true);
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(User, 'findById', async () => ({ refundAutoDisabled: false }));
  mock.method(paymentService as any, 'settleEscrow', async () => undefined);
  const counted = mock.method(paymentService as any, 'recordBuyerRefund', async () => undefined);

  const result = await paymentService.processRefund(String(hold._id), 'Akkaunt ishlamayapti');
  assert.equal(result.allowed, true);
  assert.equal(counted.mock.callCount(), 1);
});
