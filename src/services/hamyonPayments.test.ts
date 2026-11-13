import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { Product } from '../models/Product';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { hamyonClient } from './hamyonClient';
import { claimHamyonPaid, reconcileHamyonPayment, resolveHamyonReview } from './hamyonPayments';
import { notificationService } from './notificationService';
import { paymentService } from './paymentService';

// No database: every model call these paths make is replaced, so each test pins down exactly
// which documents a decision is allowed to touch.

afterEach(() => mock.restoreAll());

const id = () => new mongoose.Types.ObjectId();

test('rejecting one buyer’s claim leaves another buyer’s reservation in place', async () => {
  const productId = id();
  const buyerA = id(); // claimed "I paid", admin says no
  const buyerB = id(); // reserved the relisted product and is paying right now
  const order = { _id: id(), paymentProvider: 'hamyon', status: 'expired', productId, buyerId: buyerA, uniqueAmount: 50_000 };

  // The listing as it is in the database: re-reserved by B after A's order was cancelled.
  const product: any = { _id: productId, status: 'reserved', reservedBy: buyerB };
  mock.method(Product, 'findOneAndUpdate', async (filter: any) => {
    const matches = String(filter._id) === String(product._id) && filter.status === product.status &&
      (!filter.reservedBy || String(filter.reservedBy) === String(product.reservedBy));
    if (!matches) return null;
    product.status = 'active';
    delete product.reservedBy;
    return product;
  });
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(User, 'findById', async () => ({ telegramId: 111 }));
  mock.method(notificationService, 'notifyBuyer', async () => true);

  const result = await resolveHamyonReview(String(order._id), false, String(id()));

  assert.equal(result.ok, true);
  assert.equal(product.status, 'reserved', 'B’s reservation must survive');
  assert.equal(String(product.reservedBy), String(buyerB));
});

test('rejecting a claim still frees the listing when this buyer holds it', async () => {
  const productId = id();
  const buyer = id();
  const order = { _id: id(), paymentProvider: 'hamyon', status: 'pending_payment', productId, buyerId: buyer, uniqueAmount: 50_000 };

  const release = mock.method(Product, 'findOneAndUpdate', async () => ({ _id: productId }));
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(User, 'findById', async () => ({ telegramId: 111 }));
  mock.method(notificationService, 'notifyBuyer', async () => true);

  await resolveHamyonReview(String(order._id), false, String(id()));

  assert.equal(release.mock.callCount(), 1);
  const filter: any = release.mock.calls[0].arguments[0];
  assert.equal(filter.status, 'reserved');
  assert.equal(String(filter.reservedBy), String(buyer), 'release is scoped to the order’s own buyer');
});

test('a "paid" claim on an order still in its payment window is not sent to review', async () => {
  const order: any = {
    _id: id(), paymentProvider: 'hamyon', status: 'pending_payment', hamyonPaymentId: 'p1',
    uniqueAmount: 50_000, expireAt: new Date(Date.now() + 5 * 60_000), productId: id(), buyerId: id(),
  };
  mock.method(Transaction, 'findOne', async () => order);
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  // Hamyon has not seen the transfer yet.
  mock.method(hamyonClient, 'getStatus', async () => ({ payment_id: 'p1', amount: 50_000, status: 'pending' as const }));
  const flag = mock.method(Transaction, 'findOneAndUpdate', async () => order);
  const adminNotice = mock.method(notificationService, 'notifyAdmin', async () => true);

  const result = await claimHamyonPaid(String(order._id), String(order.buyerId));

  assert.equal(result, 'pending');
  assert.equal(flag.mock.callCount(), 0, 'no paymentReview flag: automatic checks must keep running');
  assert.equal(adminNotice.mock.callCount(), 0);
});

test('a "paid" claim on an order Hamyon cancelled still goes to an admin', async () => {
  const order: any = {
    _id: id(), paymentProvider: 'hamyon', status: 'expired', cancelReason: 'hamyon_payment_cancelled',
    hamyonPaymentId: 'p2', uniqueAmount: 70_000, expireAt: new Date(Date.now() - 60_000),
    createdAt: new Date(), productId: id(), buyerId: id(),
  };
  mock.method(Transaction, 'findOne', async () => order);
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(hamyonClient, 'getStatus', async () => ({ payment_id: 'p2', amount: 70_000, status: 'cancel' as const }));
  const flag = mock.method(Transaction, 'findOneAndUpdate', async () => order);
  mock.method(User, 'findById', async () => ({ telegramId: 222, username: 'buyer' }));
  mock.method(Product, 'findById', async () => ({ title: 'Akkaunt', status: 'active' }));
  const adminNotice = mock.method(notificationService, 'notifyAdmin', async () => true);

  const result = await claimHamyonPaid(String(order._id), String(order.buyerId));

  assert.equal(result, 'review');
  assert.equal(flag.mock.callCount(), 1);
  assert.deepEqual((flag.mock.calls[0].arguments as any[])[1], { $set: { paymentReview: 'buyer_says_paid' } });
  assert.equal(adminNotice.mock.callCount(), 1);
});

function fakeSession() {
  return { withTransaction: async (fn: () => Promise<unknown>) => fn(), endSession: async () => undefined } as any;
}

test('an order Hamyon still calls "pending" long after its deadline releases the listing', async () => {
  const order: any = {
    _id: id(), paymentProvider: 'hamyon', status: 'pending_payment', hamyonPaymentId: 'p3', uniqueAmount: 60_000,
    expireAt: new Date(Date.now() - 60 * 60_000), productId: id(), buyerId: id(),
  };
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(hamyonClient, 'getStatus', async () => ({ payment_id: 'p3', amount: 60_000, status: 'pending' as const }));
  mock.method(mongoose, 'startSession', async () => fakeSession());
  const expire = mock.method(Transaction, 'findOneAndUpdate', async () => ({ ...order, status: 'expired' }));
  const release = mock.method(Product, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(User, 'findById', async () => ({ telegramId: 333 }));
  mock.method(Product, 'findById', async () => ({ title: 'Akkaunt' }));
  mock.method(notificationService, 'notifyBuyer', async () => true);

  await reconcileHamyonPayment(String(order._id));

  assert.equal(expire.mock.callCount(), 1);
  assert.deepEqual((expire.mock.calls[0].arguments as any[])[1], { $set: { status: 'expired', cancelReason: 'hamyon_payment_timeout' } });
  assert.equal(release.mock.callCount(), 1, 'the reserved listing goes back on sale');
});

test('a "pending" order still near its deadline is left alone', async () => {
  const order: any = {
    _id: id(), paymentProvider: 'hamyon', status: 'pending_payment', hamyonPaymentId: 'p4', uniqueAmount: 60_000,
    expireAt: new Date(Date.now() - 2 * 60_000), productId: id(), buyerId: id(),
  };
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(hamyonClient, 'getStatus', async () => ({ payment_id: 'p4', amount: 60_000, status: 'pending' as const }));
  const expire = mock.method(Transaction, 'findOneAndUpdate', async () => null);

  await reconcileHamyonPayment(String(order._id));
  assert.equal(expire.mock.callCount(), 0);
});

test('a "paid" that arrives after a timeout still settles the order', async () => {
  const order: any = {
    _id: id(), paymentProvider: 'hamyon', status: 'expired', cancelReason: 'hamyon_payment_timeout', hamyonPaymentId: 'p5',
    uniqueAmount: 60_000, expireAt: new Date(Date.now() - 60 * 60_000), productId: id(), buyerId: id(),
  };
  mock.method(Transaction, 'findById', async () => order);
  mock.method(Transaction, 'updateOne', async () => ({ modifiedCount: 1 }));
  mock.method(hamyonClient, 'getStatus', async () => ({ payment_id: 'p5', amount: 60_000, status: 'paid' as const }));
  mock.method(mongoose, 'startSession', async () => fakeSession());
  mock.method(Product, 'exists', () => ({ session: async () => ({ _id: order.productId }) }));
  const claim = mock.method(Transaction, 'findOneAndUpdate', async (filter: any) =>
    filter.status === 'expired' ? { ...order, status: 'paid' } : null);
  const fund = mock.method(paymentService, 'fundEscrow', async () => ({ _id: id() }) as any);

  await reconcileHamyonPayment(String(order._id));

  assert.equal(fund.mock.callCount(), 1, 'money that arrived late is put into escrow');
  assert.equal((claim.mock.calls[0].arguments as any[])[0].status, 'expired');
});
