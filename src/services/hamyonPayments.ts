import mongoose from 'mongoose';
import { config } from '../config';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { hamyonClient } from './hamyonClient';
import { notificationService } from './notificationService';
import { paymentService } from './paymentService';

async function expireOrder(id: mongoose.Types.ObjectId, reason: string) {
  const session = await mongoose.startSession();
  let expired: any = null;
  try {
    await session.withTransaction(async () => {
      expired = await Transaction.findOneAndUpdate(
        { _id: id, status: 'pending_payment' },
        { $set: { status: 'expired', cancelReason: reason }, $unset: { paymentCard: '' } },
        { session }
      );
      if (!expired) return;
      await Product.updateOne(
        { _id: expired.productId, status: 'reserved', reservedBy: expired.buyerId },
        { $set: { status: 'active' }, $unset: { reservedBy: '', reservedUntil: '' } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  if (!expired) return;

  const [buyer, product] = await Promise.all([User.findById(expired.buyerId), Product.findById(expired.productId)]);
  if (buyer?.telegramId) {
    await notificationService.notifyPaymentWindowExpired(buyer.telegramId, product?.title || 'Mahsulot', String(expired.productId));
  }
}

/**
 * Settles one order from Hamyon's own status endpoint. Callbacks only trigger this: the callback
 * signature does not cover `status`, so only this server-to-server answer may move an order.
 */
export async function reconcileHamyonPayment(id: string) {
  const t = await Transaction.findById(id);
  if (!t || t.paymentProvider !== 'hamyon' || t.status !== 'pending_payment' || t.paymentReview) return;

  await Transaction.updateOne({ _id: t._id }, { $set: { hamyonCheckedAt: new Date() } });

  // Creation crashed before the id was stored: no card was shown, so nobody can have paid.
  if (!t.hamyonPaymentId) {
    if (t.expireAt.getTime() < Date.now()) await expireOrder(t._id as mongoose.Types.ObjectId, 'hamyon_payment_never_created');
    return;
  }

  const remote = await hamyonClient.getStatus(t.hamyonPaymentId);
  const sameShop = remote.shop_id === undefined || String(remote.shop_id) === config.hamyon.shopId;
  if (remote.payment_id !== t.hamyonPaymentId || remote.amount !== t.uniqueAmount || !sameShop) {
    console.error('[Hamyon] Status mismatch:', id, { idMatch: remote.payment_id === t.hamyonPaymentId, remoteAmount: remote.amount, expected: t.uniqueAmount, sameShop });
    await Transaction.updateOne({ _id: t._id }, { $set: { paymentReview: 'hamyon_status_mismatch' } });
    return;
  }

  if (remote.status === 'cancel') {
    await expireOrder(t._id as mongoose.Types.ObjectId, 'hamyon_payment_cancelled');
    return;
  }
  if (remote.status !== 'paid') return;
  console.log('[Hamyon] Paid:', id);

  const session = await mongoose.startSession();
  let lostReservation = false;
  try {
    await session.withTransaction(async () => {
      lostReservation = false;
      const reserved = await Product.exists({ _id: t.productId, status: 'reserved', reservedBy: t.buyerId }).session(session);
      if (!reserved) {
        lostReservation = true;
        return;
      }
      const claimed = await Transaction.findOneAndUpdate(
        { _id: t._id, status: 'pending_payment', paymentReview: { $exists: false } },
        { $set: { status: 'paid', paidAt: new Date() } },
        { new: true, session }
      );
      if (!claimed) return;
      await paymentService.fundEscrow(claimed, session, {
        provider: 'hamyon',
        paymentId: t.hamyonPaymentId,
        paidAmount: remote.amount,
      });
    });
  } finally {
    await session.endSession();
  }
  if (lostReservation) console.error('[Hamyon] Paid order lost its reservation:', id);
  else await notifyHamyonPaid(id).catch(() => console.error('[Hamyon] Paid notice deferred:', id));
  // Real money arrived for a listing that is no longer held: a person has to decide.
  if (lostReservation) {
    await Transaction.updateOne({ _id: t._id }, { $set: { paymentReview: 'hamyon_paid_reservation_lost' } });
  }
}

/**
 * Sends the "payment received" message with the reveal button exactly once. The row is claimed
 * before sending, so the bot's watcher and the backend's sweep cannot both deliver it.
 */
export async function notifyHamyonPaid(id: string): Promise<boolean> {
  const t = await Transaction.findOneAndUpdate(
    { _id: id, status: { $in: ['paid', 'completed'] }, paymentNotifiedAt: { $exists: false } },
    { $set: { paymentNotifiedAt: new Date() } },
    { new: true }
  );
  if (!t) return false;
  const [buyer, product, hold] = await Promise.all([
    User.findById(t.buyerId),
    Product.findById(t.productId),
    EscrowHold.findOne({ transactionId: t._id }),
  ]);
  const sent = !!buyer?.telegramId && !!hold &&
    await notificationService.notifyPaymentConfirmed(buyer.telegramId, product?.title || 'Mahsulot', t.basePrice, String(hold._id), hold.autoReleaseAt);
  if (!sent) await Transaction.updateOne({ _id: t._id }, { $unset: { paymentNotifiedAt: '' } });
  return sent;
}

/** Throttled reconcile for a buyer who is waiting right now (bot button, bot watcher, web poll). */
export async function checkHamyonOrder(id: string, minIntervalMs = 5_000) {
  const t = await Transaction.findById(id).select('paymentProvider status paymentReview hamyonCheckedAt');
  if (t?.paymentProvider === 'hamyon' && t.status === 'pending_payment' && !t.paymentReview) {
    const last = t.hamyonCheckedAt?.getTime() || 0;
    if (Date.now() - last >= minIntervalMs) await reconcileHamyonPayment(id);
  }
  return Transaction.findById(id);
}

let sweeping = false;

/** Backstop for callbacks lost while this service was asleep or restarting. */
export async function sweepHamyonPayments() {
  if (sweeping) return;
  sweeping = true;
  try {
    const pending = await Transaction.find({ paymentProvider: 'hamyon', status: 'pending_payment', paymentReview: { $exists: false } })
      .sort({ hamyonCheckedAt: 1, createdAt: 1 })
      .limit(30);
    for (const t of pending) {
      try {
        await reconcileHamyonPayment(String(t._id));
      } catch {
        console.error('[Hamyon] Reconciliation deferred:', String(t._id));
      }
    }

    const reviews = await Transaction.find({ paymentProvider: 'hamyon', paymentReview: { $exists: true }, paymentReviewNotifiedAt: { $exists: false } }).limit(20);
    for (const t of reviews) {
      const sent = await notificationService.notifyAdmin(`⚠️ Hamyon buyurtmasini tekshiring: ${t._id}. Sabab: ${t.paymentReview}`);
      if (sent) await Transaction.updateOne({ _id: t._id }, { $set: { paymentReviewNotifiedAt: new Date() } });
    }

    const paid = await Transaction.find({ paymentProvider: 'hamyon', status: 'paid', paymentNotifiedAt: { $exists: false } }).limit(30);
    for (const t of paid) await notifyHamyonPaid(String(t._id));
  } finally {
    sweeping = false;
  }
}
