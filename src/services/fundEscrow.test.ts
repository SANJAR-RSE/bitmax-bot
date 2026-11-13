import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { accounts, ledgerService } from './ledgerService';
import { paymentService } from './paymentService';

afterEach(() => mock.restoreAll());

async function fund(basePrice: number, uniqueAmount: number | undefined) {
  const holdId = new mongoose.Types.ObjectId();
  mock.method(Product, 'findByIdAndUpdate', async () => ({}));
  mock.method(EscrowHold, 'create', async () => [{ _id: holdId }]);
  mock.method(User, 'findByIdAndUpdate', async () => ({}));
  const post = mock.method(ledgerService, 'post', async () => ({ entry: {} as any, created: true }));

  const transaction = {
    _id: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(),
    buyerId: new mongoose.Types.ObjectId(), sellerId: new mongoose.Types.ObjectId(), basePrice, uniqueAmount,
  };
  await paymentService.fundEscrow(transaction, {} as mongoose.ClientSession, {});
  const postings = (post.mock.calls[0].arguments as any[])[0].postings as { account: string; amount: number }[];
  const at = (account: string) => postings.filter((p) => p.account === account).reduce((s, p) => s + p.amount, 0);
  return { postings, at, escrow: accounts.escrow(String(holdId)) };
}

test('the ledger records everything the buyer actually transferred, not just the price', async () => {
  // Hamyon: price 50 000, this order took the next free so'm → buyer sent 50 007.
  const { postings, at, escrow } = await fund(50_000, 50_007);
  assert.equal(at(accounts.externalBank), -50_007, 'bank leg equals the money that arrived');
  assert.equal(at(escrow), 50_000, 'escrow holds exactly the sale price');
  assert.equal(at(accounts.platformRevenue), 7, 'the tail is platform revenue, not lost');
  assert.equal(postings.reduce((s, p) => s + p.amount, 0), 0, 'entry balances');
});

test('the SMS tail (100–999 so’m) is recorded the same way', async () => {
  const { at, escrow } = await fund(120_000, 120_437);
  assert.equal(at(accounts.externalBank), -120_437);
  assert.equal(at(escrow), 120_000);
  assert.equal(at(accounts.platformRevenue), 437);
});

test('no surplus means no revenue posting', async () => {
  const { postings, at } = await fund(80_000, 80_000);
  assert.equal(postings.length, 2);
  assert.equal(at(accounts.externalBank), -80_000);
});

test('one buyer cannot hold more than two unpaid orders at once', async () => {
  const { Transaction } = await import('../models/Transaction');
  const { MAX_OPEN_PAYMENTS, OpenPaymentLimitError } = await import('./paymentService');
  mock.method(Transaction, 'countDocuments', async () => MAX_OPEN_PAYMENTS);
  const reserve = mock.method(Product, 'findOneAndUpdate', async () => null);

  await assert.rejects(
    paymentService.createPaymentTransaction(String(new mongoose.Types.ObjectId()), String(new mongoose.Types.ObjectId())),
    OpenPaymentLimitError
  );
  assert.equal(reserve.mock.callCount(), 0, 'no listing is reserved');
});

test('below the limit a purchase goes ahead to the reservation', async () => {
  const { Transaction } = await import('../models/Transaction');
  const { ProductUnavailableError } = await import('./paymentService');
  let counted: any;
  mock.method(Transaction, 'countDocuments', async (filter: any) => { counted = filter; return 1; });
  const reserve = mock.method(Product, 'findOneAndUpdate', async () => null); // sold out, but it was tried

  await assert.rejects(
    paymentService.createPaymentTransaction(String(new mongoose.Types.ObjectId()), String(new mongoose.Types.ObjectId())),
    ProductUnavailableError
  );
  assert.equal(reserve.mock.callCount(), 1);
  assert.equal(counted.status, 'pending_payment');
  assert.ok(counted.expireAt.$gt instanceof Date, 'lapsed orders do not count against the buyer');
});
