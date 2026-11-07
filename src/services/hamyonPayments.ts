import mongoose from 'mongoose';
import { config } from '../config';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { escapeHtml, formatUzs } from '../utils/helpers';
import { hamyonClient } from './hamyonClient';
import { notificationService } from './notificationService';
import { paymentService } from './paymentService';

/** How long after Hamyon cancelled an order a late "paid" or a buyer's claim can still settle it. */
const LATE_WINDOW_MS = 24 * 60 * 60_000;

function isLateCancelled(t: any) {
  return t.status === 'expired' && t.cancelReason === 'hamyon_payment_cancelled' &&
    Date.now() - new Date(t.expireAt).getTime() < LATE_WINDOW_MS;
}

async function expireOrder(id: mongoose.Types.ObjectId, reason: string) {
  const session = await mongoose.startSession();
  let expired: any = null;
  try {
    await session.withTransaction(async () => {
      // The card number is kept: an admin checking a "I did pay" claim needs to know where to look.
      expired = await Transaction.findOneAndUpdate(
        { _id: id, status: 'pending_payment' },
        { $set: { status: 'expired', cancelReason: reason } },
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
  if (!buyer?.telegramId) return;
  await notificationService.notifyBuyer(
    buyer.telegramId,
    [
      `⏳ <b>To‘lov topilmadi</b>`,
      '',
      `<b>${escapeHtml(product?.title || 'Mahsulot')}</b> uchun 5 daqiqa ichida <code>${expired.uniqueAmount}</code> so‘m tushgani aniqlanmadi, buyurtma bekor qilindi.`,
      '',
      `Agar pulni <b>allaqachon o‘tkazgan bo‘lsangiz</b>, pastdagi tugmani bosing — admin tekshirib, akkaunt ma’lumotlarini beradi. Qayta pul o‘tkazmang.`,
    ].join('\n'),
    [
      [{ text: '💸 Men pul o‘tkazgandim', callback_data: `hpay_claim_${expired._id}` }],
      [{ text: '🔍 Mahsulotni ko‘rish', callback_data: `detail_${expired.productId}` }],
    ]
  );
}

/** Admin buttons for an order a person has to decide on. */
export function hamyonReviewButtons(id: string) {
  return [[
    { text: '✅ Pul tushdi — tasdiqlash', callback_data: `hpay_ok_${id}` },
    { text: '❌ Tushmagan', callback_data: `hpay_no_${id}` },
  ]];
}

export async function notifyAdminHamyonReview(id: string, reason: string) {
  const t = await Transaction.findById(id);
  if (!t) return false;
  const [buyer, product] = await Promise.all([User.findById(t.buyerId), Product.findById(t.productId)]);
  const card = t.paymentCard ? `•••• ${t.paymentCard.slice(-4)}` : '—';
  const sent = await notificationService.notifyAdmin(
    [
      `⚠️ <b>Hamyon to‘lovini tekshiring</b>`,
      `Sabab: ${escapeHtml(reason)}`,
      '',
      `Mahsulot: ${escapeHtml(product?.title || '—')} (holati: ${product?.status || '—'})`,
      `Xaridor: ${buyer?.username ? '@' + escapeHtml(buyer.username) : buyer?.telegramId || '—'}`,
      `Summa: <code>${t.uniqueAmount}</code> so‘m · karta ${card}`,
      `Yaratilgan: ${t.createdAt?.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
      `Hamyon ID: <code>${escapeHtml(t.hamyonPaymentId || '—')}</code>`,
      `Buyurtma: <code>${t._id}</code>`,
      '',
      `Kartaga shu summa tushganini tekshirib, tugmani bosing.`,
    ].join('\n'),
    hamyonReviewButtons(String(t._id))
  );
  if (sent) await Transaction.updateOne({ _id: t._id }, { $set: { paymentReviewNotifiedAt: new Date() } });
  return sent;
}

/**
 * Moves a Hamyon order into escrow. Accepts a still-pending order, or one Hamyon cancelled within
 * the last day, as long as the listing is still free or still held for this buyer.
 */
export async function settleHamyonOrder(id: string, meta: Record<string, unknown>): Promise<'settled' | 'unavailable' | 'noop'> {
  const t = await Transaction.findById(id);
  if (!t || t.paymentProvider !== 'hamyon') return 'noop';
  if (t.status !== 'pending_payment' && !isLateCancelled(t)) return 'noop';

  const session = await mongoose.startSession();
  let result = 'noop' as 'settled' | 'unavailable' | 'noop';
  try {
    await session.withTransaction(async () => {
      result = 'noop';
      const free = await Product.exists({
        _id: t.productId,
        $or: [{ status: 'reserved', reservedBy: t.buyerId }, { status: 'active' }],
      }).session(session);
      if (!free) {
        result = 'unavailable';
        return;
      }
      const claimed = await Transaction.findOneAndUpdate(
        { _id: t._id, status: t.status },
        { $set: { status: 'paid', paidAt: new Date() }, $unset: { cancelReason: '', paymentReview: '' } },
        { new: true, session }
      );
      if (!claimed) return;
      await paymentService.fundEscrow(claimed, session, { provider: 'hamyon', paymentId: t.hamyonPaymentId, ...meta });
      result = 'settled';
    });
  } finally {
    await session.endSession();
  }
  if (result === 'settled') {
    console.log('[Hamyon] Settled:', id, meta.by || 'hamyon');
    await notifyHamyonPaid(id).catch(() => console.error('[Hamyon] Paid notice deferred:', id));
  }
  return result;
}

/**
 * Settles one order from Hamyon's own status endpoint. Callbacks only trigger this: the callback
 * signature does not cover `status`, so only this server-to-server answer may move an order.
 */
export async function reconcileHamyonPayment(id: string) {
  const t = await Transaction.findById(id);
  if (!t || t.paymentProvider !== 'hamyon' || t.paymentReview) return;
  if (t.status !== 'pending_payment' && !isLateCancelled(t)) return;

  await Transaction.updateOne({ _id: t._id }, { $set: { hamyonCheckedAt: new Date() } });

  // Creation crashed before the id was stored: no card was shown, so nobody can have paid.
  if (!t.hamyonPaymentId) {
    if (t.status === 'pending_payment' && t.expireAt.getTime() < Date.now()) {
      await expireOrder(t._id as mongoose.Types.ObjectId, 'hamyon_payment_never_created');
    }
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
    if (t.status === 'pending_payment') {
      console.log('[Hamyon] Cancelled by Hamyon (no matching transfer seen):', id);
      await expireOrder(t._id as mongoose.Types.ObjectId, 'hamyon_payment_cancelled');
    }
    return;
  }
  if (remote.status !== 'paid') return;
  console.log('[Hamyon] Paid:', id, t.status === 'expired' ? '(after cancel)' : '');

  const result = await settleHamyonOrder(id, { paidAmount: remote.amount });
  // Real money arrived for a listing that is no longer available: a person has to decide.
  if (result === 'unavailable') {
    console.error('[Hamyon] Paid order lost its listing:', id);
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

/** A buyer says they paid an order Hamyon cancelled: re-ask Hamyon, then hand it to an admin. */
export async function claimHamyonPaid(id: string, buyerId: string): Promise<'settled' | 'review' | 'already' | 'invalid'> {
  const t = await Transaction.findOne({ _id: id, buyerId, paymentProvider: 'hamyon' });
  if (!t) return 'invalid';
  if (t.status === 'paid' || t.status === 'completed') return 'already';
  if (t.paymentReview) return 'review';
  if (!isLateCancelled(t) && t.status !== 'pending_payment') return 'invalid';

  await reconcileHamyonPayment(id).catch(() => console.error('[Hamyon] Claim re-check failed:', id));
  const after = await Transaction.findById(id);
  if (after?.status === 'paid' || after?.status === 'completed') return 'settled';

  const marked = await Transaction.findOneAndUpdate(
    { _id: id, paymentReview: { $exists: false } },
    { $set: { paymentReview: 'buyer_says_paid' } }
  );
  if (marked) await notifyAdminHamyonReview(id, 'Xaridor pul o‘tkazganini aytmoqda, Hamyon esa topmadi');
  return 'review';
}

/** Admin decision on a reviewed order. */
export async function resolveHamyonReview(id: string, approve: boolean, adminId: string) {
  const t = await Transaction.findById(id);
  if (!t || t.paymentProvider !== 'hamyon') return { ok: false, message: 'Buyurtma topilmadi' };
  if (t.status === 'paid' || t.status === 'completed') return { ok: false, message: 'Allaqachon tasdiqlangan' };
  const buyer = await User.findById(t.buyerId);

  if (!approve) {
    await Transaction.updateOne(
      { _id: t._id, status: { $in: ['pending_payment', 'expired'] } },
      { $set: { status: 'expired', cancelReason: 'hamyon_review_rejected', paymentReview: 'rejected' } }
    );
    await paymentService.releaseReservation(String(t.productId));
    await notificationService.notifyBuyer(
      buyer?.telegramId,
      `❌ <b>To‘lov topilmadi</b>\n\nAdmin <code>${t.uniqueAmount}</code> so‘m kartaga tushganini tasdiqlamadi. Savol bo‘lsa, @${escapeHtml(config.supportUsername)} ga yozing.`
    );
    return { ok: true, message: 'Rad etildi' };
  }

  // An admin decision reopens a cancelled order for settlement.
  if (t.status === 'expired') {
    await Transaction.updateOne({ _id: t._id, status: 'expired' }, { $set: { cancelReason: 'hamyon_payment_cancelled', expireAt: new Date() } });
  }
  const result = await settleHamyonOrder(id, { by: 'admin', adminId, paidAmount: t.uniqueAmount });
  if (result === 'settled') return { ok: true, message: `Tasdiqlandi: ${formatUzs(t.basePrice)}` };
  if (result === 'unavailable') return { ok: false, message: 'Mahsulot boshqa xaridorga o‘tgan yoki sotilgan — pulni qaytaring' };
  return { ok: false, message: 'Buyurtmani o‘zgartirib bo‘lmadi' };
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

    const reviews = await Transaction.find({
      paymentProvider: 'hamyon',
      paymentReview: { $exists: true, $ne: 'rejected' },
      status: { $in: ['pending_payment', 'expired'] },
      paymentReviewNotifiedAt: { $exists: false },
    }).limit(20);
    for (const t of reviews) await notifyAdminHamyonReview(String(t._id), String(t.paymentReview));

    const paid = await Transaction.find({ paymentProvider: 'hamyon', status: 'paid', paymentNotifiedAt: { $exists: false } }).limit(30);
    for (const t of paid) await notifyHamyonPaid(String(t._id));
  } finally {
    sweeping = false;
  }
}
