import mongoose from 'mongoose';
import { Transaction, ITransaction } from '../models/Transaction';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { EscrowHold } from '../models/EscrowHold';
import { TezcheckEvent } from '../models/TezcheckEvent';
import { paymentService } from './paymentService';
import { notificationService } from './notificationService';
import { tezcheckClient, isLivePaid, toMinor } from './tezcheckClient';

export async function ensureTezcheckBill(t: ITransaction) {
  if (t.tezcheckBillId || t.status !== 'pending_payment' || t.paymentReview) return;
  // Never re-create after the provider forgets the idempotency key.
  if (Date.now() - t.createdAt.getTime() > 23 * 3600_000) {
    await Transaction.updateOne({ _id: t._id }, { $set: { paymentReview: 'bill_creation_recovery_window_elapsed' } });
    return;
  }
  if (!t.tezcheckRequest) throw new Error('Missing durable bill request');
  const data = await tezcheckClient.createBill(t.tezcheckRequest, `order-${t._id}`);
  if (data.bill.external_reference !== String(t._id) || data.bill.amount_minor !== toMinor(t.basePrice)) {
    throw new Error('TezCheck created bill does not match order');
  }
  await Transaction.updateOne({ _id: t._id, status: 'pending_payment' }, { $set: {
    tezcheckBillId: data.bill.id, paymentUrl: data.payment_url,
  } });
  t.tezcheckBillId = data.bill.id;
  t.paymentUrl = data.payment_url;
}

export async function reconcileTezcheckPayment(id: string) {
  const t = await Transaction.findById(id);
  if (!t || t.paymentProvider !== 'tezcheck' || t.status !== 'pending_payment' || t.paymentReview) return;
  await Transaction.updateOne({ _id: t._id }, { $set: { tezcheckCheckedAt: new Date() } });
  await ensureTezcheckBill(t);
  if (!t.tezcheckBillId) return;
  let data = await tezcheckClient.getBill(t.tezcheckBillId);
  const expected = { id: t.tezcheckBillId, reference: String(t._id), amountMinor: toMinor(t.basePrice) };
  if (isLivePaid(data, expected)) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const claimed = await Transaction.findOneAndUpdate({ _id: t._id, status: 'pending_payment', paymentReview: { $exists: false } }, {
          $set: { status: 'paid', paidAt: new Date(), tezcheckPaymentId: data.payment!.id,
            tezcheckAmountMinor: data.payment!.amount_minor, tezcheckFeeMinor: data.payment!.fee_minor,
            tezcheckNetMinor: data.payment!.net_minor },
        }, { new: true, session });
        if (!claimed) return;
        const reserved = await Product.exists({ _id: t.productId, status: 'reserved', reservedBy: t.buyerId }).session(session);
        if (!reserved) throw new Error('Paid order lost product reservation; operator review required');
        await paymentService.fundEscrow(claimed, session, {
          provider: 'tezcheck', paymentId: data.payment!.id, amountMinor: data.payment!.amount_minor,
          feeMinor: data.payment!.fee_minor, netMinor: data.payment!.net_minor,
        });
      });
    } finally { await session.endSession(); }
    return;
  }
  // A paid test/refunded/problematic payment never becomes a real escrow.
  if (data.bill.paid || data.payment?.state === 'succeeded') {
    await Transaction.updateOne({ _id: t._id }, { $set: { paymentReview: 'non_live_or_non_settleable_payment' } });
    return;
  }
  if (t.expireAt.getTime() > Date.now()) return;
  if (data.payment?.problem?.unknown_reason || ['processing', 'requires_action'].includes(data.payment?.state || '')) return;
  // Only terminal unpaid payments (or no payment) permit stock release.
  if (data.payment && !['failed', 'canceled', 'expired'].includes(data.payment.state)) return;
  const canceled = await tezcheckClient.cancelBill(t.tezcheckBillId);
  if (canceled.cancelled !== true) return;
  data = await tezcheckClient.getBill(t.tezcheckBillId);
  if (data.bill.paid || data.payment?.state === 'succeeded') return; // Next sweep settles it.
  if (data.bill.id !== expected.id || data.bill.external_reference !== expected.reference || data.bill.state !== 'revoked' ||
      data.payment?.problem?.unknown_reason || (data.payment && !['failed', 'canceled', 'expired'].includes(data.payment.state))) return;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const expired = await Transaction.findOneAndUpdate({ _id: t._id, status: 'pending_payment' },
        { $set: { status: 'expired', cancelReason: 'tezcheck_bill_cancelled' }, $unset: { paymentUrl: '' } }, { session });
      if (!expired) return;
      await Product.updateOne({ _id: t.productId, status: 'reserved', reservedBy: t.buyerId },
        { $set: { status: 'active' }, $unset: { reservedBy: '', reservedUntil: '' } }, { session });
    });
  } finally { await session.endSession(); }
}

export async function processTezcheckEvents() {
  const events = await TezcheckEvent.find({ processedAt: { $exists: false } }).sort({ attemptedAt: 1, createdAt: 1 }).limit(20);
  for (const event of events) {
    try {
      await TezcheckEvent.updateOne({ _id: event._id }, { $set: { attemptedAt: new Date() } });
      const payload = event.payload;
      const reference = payload.data.external_reference;
      const t = mongoose.isValidObjectId(reference) ? await Transaction.findById(reference) : null;
      if (!t || t.paymentProvider !== 'tezcheck' || !t.tezcheckBillId) {
        if (t && !t.tezcheckBillId) continue; // Creation response may still be in flight.
        await TezcheckEvent.updateOne({ _id: event._id }, { $set: { review: 'unmatched', processedAt: new Date() } });
        continue;
      }
      if (payload.data.bill_id !== t.tezcheckBillId) {
        await TezcheckEvent.updateOne({ _id: event._id }, { $set: { review: 'bill_mismatch', processedAt: new Date() } });
        continue;
      }
      if (['payment.refunded', 'payment.partially_refunded', 'payment.disputed', 'payment.charged_back'].includes(payload.type) && payload.data.environment === 'live') {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            await Transaction.updateOne({ _id: t._id }, { $set: { paymentReview: payload.type } }, { session });
            await EscrowHold.updateOne({ transactionId: t._id, status: 'holding' }, { $set: { status: 'disputed' } }, { session });
          });
        } finally { await session.endSession(); }
        await notificationService.notifyAdmin(`⚠️ TezCheck: ${payload.type}. Buyurtma: ${t._id}. Qo‘lda tekshiring.`);
      } else {
        await reconcileTezcheckPayment(String(t._id));
      }
      await TezcheckEvent.updateOne({ _id: event._id }, { $set: { processedAt: new Date() } });
    } catch {
      console.error('[TezCheck] Event processing deferred:', event.eventId);
    }
  }
}

let sweeping = false;
export async function sweepTezcheckPayments() {
  if (sweeping) return;
  sweeping = true;
  try {
    await processTezcheckEvents();
    const pending = await Transaction.find({ paymentProvider: 'tezcheck', status: 'pending_payment', paymentReview: { $exists: false } })
      .sort({ tezcheckCheckedAt: 1, createdAt: 1 }).limit(30);
    for (const t of pending) {
      try { await reconcileTezcheckPayment(String(t._id)); }
      catch { console.error('[TezCheck] Reconciliation deferred:', String(t._id)); }
    }
    const reviews = await Transaction.find({ paymentProvider: 'tezcheck', paymentReview: { $exists: true }, paymentReviewNotifiedAt: { $exists: false } }).limit(20);
    for (const t of reviews) {
      const sent = await notificationService.notifyAdmin(`⚠️ TezCheck buyurtmasini tekshiring: ${t._id}. Sabab: ${t.paymentReview}`);
      if (sent) await Transaction.updateOne({ _id: t._id }, { $set: { paymentReviewNotifiedAt: new Date() } });
    }
    const paid = await Transaction.find({ paymentProvider: 'tezcheck', status: 'paid', paymentNotifiedAt: { $exists: false } }).limit(30);
    for (const t of paid) {
      const [buyer, product, hold] = await Promise.all([
        User.findById(t.buyerId), Product.findById(t.productId), EscrowHold.findOne({ transactionId: t._id }),
      ]);
      if (buyer?.telegramId && hold) {
        const notified = await notificationService.notifyPaymentConfirmed(buyer.telegramId, product?.title || 'Mahsulot', t.basePrice, String(hold._id), hold.autoReleaseAt);
        if (notified) await Transaction.updateOne({ _id: t._id }, { $set: { paymentNotifiedAt: new Date() } });
      }
    }
  } finally { sweeping = false; }
}
