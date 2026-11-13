import mongoose from 'mongoose';
import { audit } from '../models/AuditLog';
import { Dispute, IDispute } from '../models/Dispute';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { config } from '../config';
import { escapeHtml, formatUzs } from '../utils/helpers';
import { notificationService } from './notificationService';
import { AlreadyProcessedError, ForbiddenError, paymentService } from './paymentService';
import { calculateRefundAmount } from './refundEngine';

/**
 * Disputes: the path for everything the automatic refund policy cannot decide — an account that
 * died after the refund window, a buyer flagged for refund abuse, a seller who pulled the
 * account back.
 *
 * Opening one moves the escrow from `holding` to `disputed`. Nothing automatic touches a
 * disputed hold (auto-release and auto-refund both select `holding` only), so the money stays
 * frozen until an admin picks an outcome, which settles it through the same ledgered path as
 * every other settlement.
 */

/** Buyer-facing reasons, keyed by the short ids the bot and the website send. */
export const DISPUTE_REASONS: Record<string, { category: IDispute['category']; label: string }> = {
  not_working: { category: 'not_working', label: 'Akkaunt ishlamayapti' },
  wrong_info: { category: 'wrong_info', label: 'E’londagi ma’lumot haqiqatga mos emas' },
  recovered: { category: 'already_recovered', label: 'Asl egasi akkauntni qaytarib oldi' },
  other: { category: 'other', label: 'Boshqa sabab' },
};

export type DisputeOutcome = 'buyer' | 'split' | 'seller';

/** Business rule, not a technical failure: the message is meant for the buyer. */
export class DisputeNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeNotAllowedError';
  }
}

const RESPONSE_HOURS = 24;
const SLA_HOURS = 72;

export function disputeAdminButtons(disputeId: string) {
  return [
    [{ text: '↩️ Xaridorga 100% qaytarish', callback_data: `dsp_res_buyer_${disputeId}` }],
    [{ text: '⚖️ Teng bo‘lish (50/50)', callback_data: `dsp_res_split_${disputeId}` }],
    [{ text: '✅ Sotuvchiga o‘tkazish', callback_data: `dsp_res_seller_${disputeId}` }],
    [{ text: '📎 Dalillarni ko‘rish', callback_data: `dsp_evv_${disputeId}` }],
  ];
}

/** The button each side gets to send screenshots, videos or a written account. */
export function disputeEvidenceButton(disputeId: string) {
  return [[{ text: '📎 Dalil yuborish', callback_data: `dsp_ev_${disputeId}` }]];
}

/** Enough for a real case; a hard stop for anyone trying to flood the admin chat. */
export const MAX_EVIDENCE = 20;

export type EvidenceInput = { kind: 'text' | 'photo' | 'video' | 'file'; ref?: string; note?: string };

/**
 * Adds one piece of evidence. Only the buyer or the seller of this dispute can, only while it
 * is open, and never past MAX_EVIDENCE: all three are part of the update's filter, so even
 * simultaneous uploads cannot get round them.
 */
export async function addEvidence(disputeId: string, userId: string, input: EvidenceInput) {
  const note = input.note?.trim().slice(0, 2000) || undefined;
  if (input.kind === 'text' && !note) throw new DisputeNotAllowedError('Bo‘sh xabar dalil bo‘la olmaydi');
  if (input.kind !== 'text' && !input.ref) throw new DisputeNotAllowedError('Fayl topilmadi');

  const user = new mongoose.Types.ObjectId(userId);
  const updated = await Dispute.findOneAndUpdate(
    {
      _id: disputeId,
      status: { $in: ['open', 'under_review'] },
      $or: [{ buyerId: user }, { sellerId: user }],
      [`evidence.${MAX_EVIDENCE - 1}`]: { $exists: false },
    },
    { $push: { evidence: { kind: input.kind, ref: input.ref, note, addedBy: user, addedAt: new Date() } } },
    { new: true }
  );
  if (updated) return updated;

  // Work out which rule refused it, to tell the person something useful.
  const dispute = await Dispute.findById(disputeId);
  if (!dispute || (String(dispute.buyerId) !== userId && String(dispute.sellerId) !== userId)) throw new ForbiddenError();
  if (!['open', 'under_review'].includes(dispute.status)) throw new DisputeNotAllowedError('Bu nizo yopilgan — dalil qabul qilinmaydi');
  throw new DisputeNotAllowedError(`Bitta nizoga ${MAX_EVIDENCE} tadan ortiq dalil yuborib bo‘lmaydi`);
}

export async function openDispute(holdId: string, buyerUserId: string, reasonType: string, details?: string) {
  const reason = DISPUTE_REASONS[reasonType];
  if (!reason) throw new DisputeNotAllowedError('Sababni tanlang');

  const hold = await EscrowHold.findById(holdId);
  if (!hold) throw new Error('Escrow hold not found');
  if (String(hold.buyerId) !== String(buyerUserId)) throw new ForbiddenError();
  if (hold.status === 'disputed') throw new DisputeNotAllowedError('Bu buyurtma bo‘yicha nizo allaqachon ochilgan');
  if (!hold.credentialsRevealedAt) {
    // Nothing was delivered yet, so the normal refund already returns 100% — no judge needed.
    throw new DisputeNotAllowedError('Ma’lumotlar hali ochilmagan — “Qaytarish” orqali pulingiz 100% qaytadi.');
  }

  // The freeze is the conditional update: only one of a double click, or of a dispute racing
  // the auto-release job, can move this hold out of `holding`.
  const frozen = await EscrowHold.findOneAndUpdate(
    { _id: hold._id, buyerId: hold.buyerId, status: 'holding' },
    { $set: { status: 'disputed' } },
    { new: true }
  );
  if (!frozen) throw new AlreadyProcessedError('Bu buyurtma yopilgan — nizo ochib bo‘lmaydi');

  const now = Date.now();
  const text = [reason.label, details?.trim()].filter(Boolean).join(' — ').slice(0, 2000);
  let dispute: IDispute;
  try {
    dispute = await Dispute.create({
      escrowHoldId: hold._id,
      transactionId: hold.transactionId,
      productId: hold.productId,
      buyerId: hold.buyerId,
      sellerId: hold.sellerId,
      openedBy: hold.buyerId,
      category: reason.category,
      reason: text,
      amount: hold.amount,
      status: 'open',
      evidence: [],
      responseDueAt: new Date(now + RESPONSE_HOURS * 3600_000),
      slaDueAt: new Date(now + SLA_HOURS * 3600_000),
    });
  } catch (err) {
    // Never leave money frozen without a dispute an admin can see and resolve.
    await EscrowHold.updateOne({ _id: hold._id, status: 'disputed' }, { $set: { status: 'holding' } });
    throw err;
  }

  await audit({
    actorId: hold.buyerId,
    action: 'dispute.opened',
    targetType: 'Dispute',
    targetId: dispute._id as mongoose.Types.ObjectId,
    after: { escrowHoldId: String(hold._id), category: reason.category },
  });

  // Notices are best-effort: the freeze and the record are what protect the money.
  await notifyOpened(dispute).catch((err) => console.error('[Dispute] Opened notice failed:', String(dispute._id), err?.message));
  return dispute;
}

async function notifyOpened(dispute: IDispute) {
  const [buyer, seller, product] = await Promise.all([
    User.findById(dispute.buyerId),
    User.findById(dispute.sellerId),
    Product.findById(dispute.productId),
  ]);
  const title = escapeHtml(product?.title || '—');
  const who = (u: any) => (u?.username ? '@' + escapeHtml(u.username) : String(u?.telegramId || '—'));

  await notificationService.notifyAdmin(
    [
      `⚖️ <b>Yangi nizo</b>`,
      '',
      `Mahsulot: ${title}`,
      `Summa: <b>${formatUzs(dispute.amount)}</b>`,
      `Xaridor: ${who(buyer)}`,
      `Sotuvchi: ${who(seller)}`,
      `Sabab: ${escapeHtml(dispute.reason)}`,
      '',
      `Pul muzlatildi — avtomatik o‘tkazilmaydi. Ikkala tomondan dalil so‘rab, qaror qiling.`,
    ].join('\n'),
    disputeAdminButtons(String(dispute._id))
  );
  await notificationService.notifySeller(
    seller?.telegramId,
    [
      `⚖️ <b>Xaridor nizo ochdi</b>`,
      '',
      `Mahsulot: ${title}`,
      `Sabab: ${escapeHtml(dispute.reason)}`,
      '',
      `Pul admin qaror qilguncha muzlatildi. Akkaunt sizdan chiqqani yoki ishlab turgani haqida ` +
        `dalillaringizni (skrinshot, video) pastdagi tugma orqali yuboring.`,
    ].join('\n'),
    disputeEvidenceButton(String(dispute._id))
  );
  await notificationService.notifyBuyer(
    buyer?.telegramId,
    `⚖️ <b>Nizo ochildi</b>\n\nPul muzlatildi va sotuvchiga o‘tmaydi. Dalillaringizni (skrinshot, video) ` +
      `pastdagi tugma orqali yuboring — admin ${SLA_HOURS} soat ichida qaror qiladi.\n\n` +
      `<i>Savol bo‘lsa: @${escapeHtml(config.supportUsername)}</i>`,
    disputeEvidenceButton(String(dispute._id))
  );
}

/** How an outcome divides the held amount. Every branch adds back up to `amount`. */
export function disputeSplit(outcome: DisputeOutcome, hold: { amount: number; sellerPayout: number; commission: number }) {
  if (outcome === 'buyer') return { buyerAmount: hold.amount, sellerAmount: 0, platformAmount: 0 };
  if (outcome === 'seller') return { buyerAmount: 0, sellerAmount: hold.sellerPayout, platformAmount: hold.commission };
  const half = calculateRefundAmount(hold.amount, 50);
  return { buyerAmount: half.refundToBuyer, sellerAmount: half.sellerKeeps, platformAmount: half.platformKeeps };
}

const RESOLVED_STATUS: Record<DisputeOutcome, IDispute['status']> = {
  buyer: 'resolved_buyer',
  split: 'resolved_split',
  seller: 'resolved_seller',
};

const SETTLED_TO_DISPUTE: Record<string, IDispute['status'] | undefined> = {
  refunded: 'resolved_buyer',
  partial_refunded: 'resolved_split',
  released: 'resolved_seller',
};

const OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  buyer: 'Xaridor foydasiga — pul to‘liq qaytarildi',
  split: 'Teng bo‘lindi (50/50)',
  seller: 'Sotuvchi foydasiga — pul sotuvchiga o‘tkazildi',
};

export async function resolveDispute(disputeId: string, outcome: DisputeOutcome, adminUserId: string) {
  const dispute = await Dispute.findOne({ _id: disputeId, status: { $in: ['open', 'under_review'] } });
  if (!dispute) return { ok: false, message: 'Nizo topilmadi yoki allaqachon hal qilingan' };

  const hold = await EscrowHold.findById(dispute.escrowHoldId);
  if (!hold) return { ok: false, message: 'Buyurtma topilmadi' };

  const split = disputeSplit(outcome, hold);
  try {
    // Settles only a hold that is still `disputed`, exactly once: a second click, or a second
    // admin, gets AlreadyProcessedError and moves nothing.
    await paymentService.settleByArbitration(String(hold._id), split, `Nizo: ${OUTCOME_LABEL[outcome]}`, adminUserId);
  } catch (err) {
    if (!(err instanceof AlreadyProcessedError)) throw err;
    // The money moved earlier but the dispute record was not closed (a crash between the two
    // writes). Close it from the escrow's actual state, or it would stay "open" and the overdue
    // reminder would nag about money that is no longer frozen.
    const settled = await EscrowHold.findById(dispute.escrowHoldId);
    const status = settled ? SETTLED_TO_DISPUTE[settled.status] : undefined;
    if (status) {
      await Dispute.updateOne(
        { _id: dispute._id, status: { $in: ['open', 'under_review'] } },
        { $set: { status, 'resolution.note': 'Pul avvalroq taqsimlangan', 'resolution.decidedAt': new Date() } }
      );
    }
    return { ok: false, message: 'Bu nizo bo‘yicha pul allaqachon taqsimlangan' };
  }

  await Dispute.updateOne(
    { _id: dispute._id },
    {
      $set: {
        status: RESOLVED_STATUS[outcome],
        resolution: {
          ...split,
          note: OUTCOME_LABEL[outcome],
          decidedBy: new mongoose.Types.ObjectId(adminUserId),
          decidedAt: new Date(),
        },
      },
    }
  );
  await audit({
    actorId: new mongoose.Types.ObjectId(adminUserId),
    action: 'dispute.resolved',
    targetType: 'Dispute',
    targetId: dispute._id as mongoose.Types.ObjectId,
    after: { outcome, ...split },
  });

  await notifyResolved(dispute, outcome, split).catch((err) =>
    console.error('[Dispute] Resolved notice failed:', String(dispute._id), err?.message)
  );
  return { ok: true, message: OUTCOME_LABEL[outcome] };
}

async function notifyResolved(dispute: IDispute, outcome: DisputeOutcome, split: ReturnType<typeof disputeSplit>) {
  const [buyer, seller, product] = await Promise.all([
    User.findById(dispute.buyerId),
    User.findById(dispute.sellerId),
    Product.findById(dispute.productId),
  ]);
  const head = `⚖️ <b>Nizo hal qilindi</b>\n\nMahsulot: ${escapeHtml(product?.title || '—')}\nQaror: ${OUTCOME_LABEL[outcome]}\n\n`;
  await notificationService.notifyBuyer(buyer?.telegramId, head + `Balansingizga: <b>${formatUzs(split.buyerAmount)}</b>`);
  await notificationService.notifySeller(seller?.telegramId, head + `Balansingizga: <b>${formatUzs(split.sellerAmount)}</b>`);
}
