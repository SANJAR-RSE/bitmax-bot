import mongoose from 'mongoose';
import { Transaction } from '../models/Transaction';
import { EscrowHold, IEscrowHold } from '../models/EscrowHold';
import { Product, ISensitiveData } from '../models/Product';
import { User } from '../models/User';
import { PaymentInbox } from '../models/PaymentInbox';
import { audit } from '../models/AuditLog';
import {
  generateUniqueAmount,
  extractAmountFromSms,
  looksLikeIncomingPayment,
  smsFingerprint,
  maskCard,
} from '../utils/helpers';
import {
  calculateSellerPayout,
  quoteRefund,
  refundDeadlineFrom,
  calculateRefundAmount,
} from './refundEngine';
import { ledgerService, accounts } from './ledgerService';
import { config } from '../config';
import { toMinor } from './tezcheckClient';
import { RefundQuote } from '../types';

export class AlreadyProcessedError extends Error {
  constructor(message = 'This escrow hold has already been processed') {
    super(message);
    this.name = 'AlreadyProcessedError';
  }
}

export class ProductUnavailableError extends Error {
  constructor(message = 'Product is not available for purchase') {
    super(message);
    this.name = 'ProductUnavailableError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Not allowed') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface SmsResult {
  matched: boolean;
  duplicate?: boolean;
  reason?: 'duplicate' | 'unparseable' | 'outgoing' | 'no_match';
  transaction?: any;
  amount?: number;
  inboxId?: string;
}

export class PaymentService {
  /**
   * Reserves the product and opens a pending transaction with an amount no other pending
   * order shares.
   *
   * Reservation is the important half: without it two buyers could both start paying for the
   * same account, both transfer money, and only one could be served. The reservation is a
   * conditional update, so exactly one caller can win it.
   */
  async createPaymentTransaction(productId: string, buyerId: string) {
    const existing = await Transaction.findOne({ productId, buyerId, status: 'pending_payment', paymentProvider: 'tezcheck' });
    if (existing) {
      const product = await Product.findById(productId);
      if (!product) throw new ProductUnavailableError();
      const { ensureTezcheckBill } = await import('./tezcheckPayments');
      await ensureTezcheckBill(existing).catch(() => undefined);
      return { transaction: existing, product, uniqueAmount: existing.basePrice,
        paymentUrl: existing.paymentReview ? undefined : existing.paymentUrl, paymentProvider: 'tezcheck', expiresAt: existing.expireAt, card: null };
    }
    const expireAt = new Date(Date.now() + config.paymentWindowMinutes * 60 * 1000);

    const product = await Product.findOneAndUpdate(
      {
        _id: productId,
        status: 'active',
        $or: [{ reservedUntil: { $exists: false } }, { reservedUntil: { $lt: new Date() } }],
      },
      {
        $set: {
          status: 'reserved',
          reservedBy: new mongoose.Types.ObjectId(buyerId),
          reservedUntil: expireAt,
        },
      },
      { new: true }
    );

    if (!product) throw new ProductUnavailableError();

    // Blocked by default: a self-purchase costs only the commission but still counts as a
    // completed sale, which is how trust levels and price ceilings are earned.
    if (!config.allowSelfPurchase && String(product.sellerId) === String(buyerId)) {
      await this.releaseReservation(String(product._id));
      throw new ForbiddenError('O‘z mahsulotingizni sotib ololmaysiz');
    }

    const card = pickCard();

    for (let attempt = 0; attempt < 10; attempt++) {
      const uniqueAmount = generateUniqueAmount(product.price);
      try {
        const transactionId = new mongoose.Types.ObjectId();
        const transaction = await Transaction.create({
          _id: transactionId,
          tezcheckRequest: config.paymentProvider === 'tezcheck' ? JSON.stringify({
            amount_minor: toMinor(product.price), title: `Buyurtma #${transactionId}`,
            external_reference: String(transactionId), allowed_provider_codes: config.tezcheck.providerCodes,
          }) : undefined,
          productId: product._id,
          buyerId,
          sellerId: product.sellerId,
          basePrice: product.price,
          expectedAmount: product.price,
          uniqueAmount,
          cardId: config.paymentProvider === 'sms' ? card?.id : undefined,
          paymentProvider: config.paymentProvider,
          status: 'pending_payment',
          expireAt,
        });

        if (config.paymentProvider === 'tezcheck') {
          const { ensureTezcheckBill } = await import('./tezcheckPayments');
          // A timeout may mean a bill exists remotely. Keep this order reserved for recovery.
          await ensureTezcheckBill(transaction).catch(() => undefined);
        }
        return {
          transaction,
          paymentProvider: transaction.paymentProvider,
          paymentUrl: transaction.paymentUrl,
          product,
          uniqueAmount: transaction.paymentProvider === 'tezcheck' ? transaction.basePrice : uniqueAmount,
          expiresAt: expireAt,
          card: transaction.paymentProvider !== 'tezcheck' && card
            ? { masked: maskCard(card.number), raw: card.number, holder: card.holder, bank: card.bank }
            : null,
        };
      } catch (err: any) {
        // E11000 = collided with another still-pending transaction's uniqueAmount; retry.
        if (err?.code === 11000) continue;
        if (!await Transaction.exists({ productId: product._id, buyerId, status: 'pending_payment', paymentProvider: 'tezcheck' })) {
          await this.releaseReservation(String(product._id));
        }
        throw err;
      }
    }

    // Could not find a free amount — don't strand the listing in `reserved`.
    await this.releaseReservation(String(product._id));
    throw new Error('Could not allocate a unique payment amount, please try again');
  }

  /** Shared only after an authenticated payment has been atomically claimed. */
  async fundEscrow(transaction: any, session: mongoose.ClientSession, meta: Record<string, unknown>) {
    const boughtAt = new Date();
    const { commission, sellerPayout } = calculateSellerPayout(transaction.basePrice);

    await Product.findByIdAndUpdate(
      transaction.productId,
      {
        $set: { status: 'sold', buyerId: transaction.buyerId, soldAt: boughtAt },
        $unset: { reservedBy: '', reservedUntil: '' },
      },
      { session }
    );

    const [hold] = await EscrowHold.create(
      [
        {
          transactionId: transaction._id,
          buyerId: transaction.buyerId,
          sellerId: transaction.sellerId,
          productId: transaction.productId,
          amount: transaction.basePrice,
          commission,
          sellerPayout,
          status: 'holding',
          boughtAt,
          // Recomputed from the reveal moment as soon as the buyer opens the credentials.
          autoReleaseAt: new Date(boughtAt.getTime() + config.unrevealedGraceHours * 3600_000),
          refundDeadlineAt: refundDeadlineFrom(boughtAt),
        },
      ],
      { session }
    );

    // Money enters the system from the bank and lands in this order's escrow account.
    await ledgerService.post(
      {
        key: `payment:${transaction._id}`,
        type: 'payment_received',
        postings: [
          { account: accounts.externalBank, amount: -transaction.basePrice },
          { account: accounts.escrow(String(hold._id)), amount: transaction.basePrice },
        ],
        refType: 'Transaction',
        refId: transaction._id as mongoose.Types.ObjectId,
        meta,
      },
      session
    );

    await User.findByIdAndUpdate(
      transaction.buyerId,
      { $inc: { totalSpent: transaction.basePrice, 'buyerStats.purchased': 1 } },
      { session }
    );

    return hold;
  }

  /** Returns a reserved-but-unpaid product to the catalog. */
  async releaseReservation(productId: string, session?: mongoose.ClientSession) {
    return Product.findOneAndUpdate(
      { _id: productId, status: 'reserved' },
      { $set: { status: 'active' }, $unset: { reservedBy: '', reservedUntil: '' } },
      session ? { session } : {}
    );
  }

  /**
   * Records an inbound bank SMS and, if it matches a pending order, settles it into escrow.
   *
   * Every message is written to PaymentInbox first — matched, duplicate, unparseable or
   * unmatched. The bank has already moved real money by the time we see the SMS, so a message
   * we cannot match is an operations task, not something to drop on the floor.
   */
  async confirmPaymentBySms(
    smsText: string,
    sender?: string,
    receivedAt?: string | number
  ): Promise<SmsResult> {
    const hash = smsFingerprint(smsText, sender, receivedAt);

    // Claim the fingerprint first. A duplicate delivery collides here and stops immediately,
    // before any money logic runs.
    let inbox;
    try {
      inbox = await PaymentInbox.create({
        rawText: smsText,
        hash,
        sender,
        receivedAt: parseReceivedAt(receivedAt),
        status: 'unmatched',
      });
    } catch (err: any) {
      if (err?.code === 11000) return { matched: false, duplicate: true, reason: 'duplicate' };
      throw err;
    }

    if (!looksLikeIncomingPayment(smsText)) {
      inbox.status = 'ignored';
      inbox.resolutionNote = 'Chiquvchi (debit) SMS — to‘lov emas';
      await inbox.save();
      return { matched: false, reason: 'outgoing', inboxId: String(inbox._id) };
    }

    const detectedAmount = extractAmountFromSms(smsText);
    if (!detectedAmount) {
      inbox.status = 'ignored';
      inbox.resolutionNote = 'Summani ajratib bo‘lmadi';
      await inbox.save();
      return { matched: false, reason: 'unparseable', inboxId: String(inbox._id) };
    }

    inbox.parsedAmount = detectedAmount;
    await inbox.save();

    const roundedAmount = Math.round(detectedAmount);
    const session = await mongoose.startSession();
    let claimedTransaction: any = null;
    let escrowId: string | null = null;

    try {
      await session.withTransaction(async () => {
        // findOneAndUpdate as the claim step means two concurrent webhook deliveries for the
        // same amount can never both succeed — the second finds no pending row left to claim.
        const transaction = await Transaction.findOneAndUpdate(
          {
            paymentProvider: { $ne: 'tezcheck' },
            uniqueAmount: roundedAmount,
            status: 'pending_payment',
            expireAt: { $gt: new Date() },
          },
          {
            $set: {
              status: 'paid',
              smsRawText: smsText,
              smsConfirmedAt: new Date(),
              paidAt: new Date(),
            },
          },
          { new: true, sort: { createdAt: 1 }, session }
        );

        if (!transaction) return;

        const hold = await this.fundEscrow(transaction, session, { uniqueAmount: roundedAmount, sender });

        claimedTransaction = transaction;
        escrowId = String(hold._id);
      });
    } finally {
      await session.endSession();
    }

    if (!claimedTransaction) {
      // Money arrived that we cannot attribute. It stays in the inbox for an operator.
      return { matched: false, reason: 'no_match', amount: detectedAmount, inboxId: String(inbox._id) };
    }

    await PaymentInbox.findByIdAndUpdate(inbox._id, {
      $set: { status: 'matched', transactionId: claimedTransaction._id },
    });

    return {
      matched: true,
      transaction: claimedTransaction,
      amount: detectedAmount,
      inboxId: String(inbox._id),
    };
  }

  /**
   * Best-effort, deliberately conservative guess at who an unmatched SMS might belong to —
   * used only to decide whether it's safe to send the buyer a cautious "we're checking"
   * message, never to actually settle anything (the SMS genuinely matched no `uniqueAmount`,
   * so nothing here moves money). A transaction counts as plausible if its base price is
   * within the unique-amount tail range (100–999) of the received amount — e.g. the sender
   * transferred the rounded price without the tail, or a digit was mistyped. If more than one
   * pending order is plausible, we deliberately return null rather than guess: reassuring the
   * wrong buyer is worse than reassuring no one.
   */
  async findPlausibleBuyerForAmount(amount: number): Promise<number | null> {
    const candidates = await Transaction.find({
      status: 'pending_payment',
      expireAt: { $gt: new Date() },
      basePrice: { $gte: amount - 999, $lte: amount },
    })
      .limit(2)
      .populate('buyerId', 'telegramId');

    if (candidates.length !== 1) return null;
    const buyer = candidates[0].buyerId as any;
    return buyer?.telegramId ?? null;
  }

  /**
   * Hands the credentials to the buyer and starts the refund clock.
   *
   * The clock deliberately starts here rather than at payment. Payment confirmation is
   * automatic and can complete while the buyer is asleep; running a 24-hour no-refund window
   * against a moment the buyer never witnessed would be indefensible. The reveal is also the
   * event a dispute is argued around, so it is timestamped and audited.
   */
  async revealCredentials(
    escrowHoldId: string,
    buyerUserId: string
  ): Promise<{ credentials: ISensitiveData; hold: IEscrowHold; firstReveal: boolean }> {
    const hold = await EscrowHold.findById(escrowHoldId);
    if (!hold) throw new Error('Escrow hold not found');
    if (String(hold.buyerId) !== String(buyerUserId)) throw new ForbiddenError();
    if (hold.status !== 'holding') {
      throw new AlreadyProcessedError('Bu buyurtma yopilgan, ma’lumotlar mavjud emas');
    }

    const product = await Product.findById(hold.productId);
    if (!product) throw new Error('Product not found');

    const credentials = product.getCredentials();
    const firstReveal = !hold.credentialsRevealedAt;

    if (firstReveal) {
      const revealedAt = new Date();
      hold.credentialsRevealedAt = revealedAt;
      hold.autoReleaseAt = new Date(revealedAt.getTime() + config.autoReleaseHours * 3600_000);
      hold.refundDeadlineAt = refundDeadlineFrom(revealedAt);
    }
    hold.credentialRevealCount += 1;
    await hold.save();

    await audit({
      actorId: hold.buyerId,
      action: 'escrow.credentials_revealed',
      targetType: 'EscrowHold',
      targetId: hold._id as mongoose.Types.ObjectId,
      after: { firstReveal, count: hold.credentialRevealCount },
    });

    return { credentials, hold, firstReveal };
  }

  /** What a refund would pay right now, without moving anything. Drives the confirm screen. */
  async quoteRefundFor(escrowHoldId: string): Promise<RefundQuote> {
    const hold = await EscrowHold.findById(escrowHoldId);
    if (!hold) throw new Error('Escrow hold not found');

    const buyer = await User.findById(hold.buyerId);
    return quoteRefund({
      amount: hold.amount,
      boughtAt: hold.boughtAt,
      revealedAt: hold.credentialsRevealedAt,
      requiresArbitration: Boolean(buyer?.refundAutoDisabled),
    });
  }

  /**
   * Atomically transitions an EscrowHold out of 'holding' exactly once. Returns null if it
   * was already settled — callers must treat that as "already processed" and never re-apply
   * a balance change.
   */
  private async claimHolding(
    escrowHoldId: string,
    update: Record<string, any>,
    session: mongoose.ClientSession
  ) {
    return EscrowHold.findOneAndUpdate({ _id: escrowHoldId, status: 'holding' }, update, {
      new: true,
      session,
    });
  }

  /**
   * Settles escrow back to the buyer under the refund policy. The forfeited share, if any,
   * is split between the seller (compensation) and the platform (its commission on that
   * share) — see refundEngine for why the buyer's percentage is the fixed promise.
   */
  async processRefund(escrowHoldId: string, reason: string, actorId?: string) {
    const existing = await EscrowHold.findById(escrowHoldId);
    if (!existing) throw new Error('Escrow hold not found');
    if (existing.status !== 'holding') throw new AlreadyProcessedError();

    const quote = await this.quoteRefundFor(escrowHoldId);

    if (!quote.allowed) {
      return { allowed: false, quote, message: quote.message };
    }

    await this.settleEscrow(escrowHoldId, {
      buyerAmount: quote.refundToBuyer,
      sellerAmount: quote.sellerKeeps,
      platformAmount: quote.platformKeeps,
      escrowStatus: quote.penaltyPercent > 0 ? 'partial_refunded' : 'refunded',
      transactionStatus: 'refunded',
      productStatus: 'refunded',
      ledgerType: 'escrow_refund',
      ledgerKey: `refund:${escrowHoldId}`,
      reason,
      period: quote.period,
      penaltyPercent: quote.penaltyPercent,
      actorId,
    });

    await this.recordBuyerRefund(String(existing.buyerId));

    return {
      allowed: true,
      quote,
      refundToBuyer: quote.refundToBuyer,
      penaltyAmount: quote.penaltyAmount,
      platformKeeps: quote.platformKeeps,
      sellerKeeps: quote.sellerKeeps,
      period: quote.period,
      message: quote.message,
    };
  }

  /** Settles escrow to the seller: payout to them, commission to the platform. */
  async releaseToSeller(escrowHoldId: string, actorId?: string) {
    const hold = await EscrowHold.findById(escrowHoldId);
    if (!hold) throw new Error('Escrow hold not found');
    if (hold.status !== 'holding') throw new AlreadyProcessedError();

    await this.settleEscrow(escrowHoldId, {
      buyerAmount: 0,
      sellerAmount: hold.sellerPayout,
      platformAmount: hold.commission,
      escrowStatus: 'released',
      transactionStatus: 'completed',
      productStatus: 'sold',
      ledgerType: 'escrow_release',
      ledgerKey: `release:${escrowHoldId}`,
      actorId,
    });

    return EscrowHold.findById(escrowHoldId);
  }

  async confirmAndRelease(escrowHoldId: string, buyerUserId?: string) {
    const hold = await EscrowHold.findById(escrowHoldId);
    if (!hold) throw new Error('Escrow hold not found');
    if (buyerUserId && String(hold.buyerId) !== String(buyerUserId)) throw new ForbiddenError();

    await this.releaseToSeller(escrowHoldId, buyerUserId);
    return { released: true, sellerPayout: hold.sellerPayout, commission: hold.commission };
  }

  /**
   * The single place escrow money is allowed to leave a hold. Every settlement — buyer refund,
   * seller release, arbitration split — goes through here, so the ledger entry and the status
   * changes are always written in one transaction and always balance.
   */
  private async settleEscrow(
    escrowHoldId: string,
    opts: {
      buyerAmount: number;
      sellerAmount: number;
      platformAmount: number;
      escrowStatus: IEscrowHold['status'];
      transactionStatus: string;
      productStatus: string;
      ledgerType: 'escrow_release' | 'escrow_refund';
      ledgerKey: string;
      reason?: string;
      period?: string;
      penaltyPercent?: number;
      actorId?: string;
    }
  ) {
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const update: Record<string, any> = {
          $set: { status: opts.escrowStatus, confirmedAt: new Date() },
        };
        if (opts.reason) {
          update.$set.refundReason = opts.reason;
          update.$set.refundPeriod = opts.period;
          update.$push = {
            refundLog: {
              action: (opts.penaltyPercent ?? 0) > 0 ? 'partial' : 'approved',
              period: opts.period || 'n/a',
              penaltyPercent: opts.penaltyPercent ?? 0,
              refundAmount: opts.buyerAmount,
              reason: opts.reason,
              actorId: opts.actorId ? new mongoose.Types.ObjectId(opts.actorId) : undefined,
              processedAt: new Date(),
            },
          };
        }

        const escrow = await this.claimHolding(escrowHoldId, update, session);
        if (!escrow) throw new AlreadyProcessedError();

        const total = opts.buyerAmount + opts.sellerAmount + opts.platformAmount;
        if (total !== escrow.amount) {
          throw new Error(
            `Settlement for ${escrowHoldId} does not balance: ${total} distributed vs ${escrow.amount} held`
          );
        }

        const postings = [{ account: accounts.escrow(escrowHoldId), amount: -escrow.amount }];
        if (opts.buyerAmount > 0) {
          postings.push({ account: accounts.userAvailable(String(escrow.buyerId)), amount: opts.buyerAmount });
        }
        if (opts.sellerAmount > 0) {
          postings.push({ account: accounts.userAvailable(String(escrow.sellerId)), amount: opts.sellerAmount });
        }
        if (opts.platformAmount > 0) {
          postings.push({ account: accounts.platformRevenue, amount: opts.platformAmount });
        }

        await ledgerService.postAndSync(
          {
            key: opts.ledgerKey,
            type: opts.ledgerType,
            postings,
            refType: 'EscrowHold',
            refId: escrow._id as mongoose.Types.ObjectId,
            meta: { period: opts.period, reason: opts.reason },
          },
          session
        );

        await Transaction.findByIdAndUpdate(
          escrow.transactionId,
          { $set: { status: opts.transactionStatus, completedAt: new Date() } },
          { session }
        );
        await Product.findByIdAndUpdate(
          escrow.productId,
          { $set: { status: opts.productStatus } },
          { session }
        );

        if (opts.sellerAmount > 0) {
          await User.findByIdAndUpdate(
            escrow.sellerId,
            { $inc: { totalEarned: opts.sellerAmount } },
            { session }
          );
        }
        if (opts.ledgerType === 'escrow_release') {
          await User.findByIdAndUpdate(escrow.sellerId, { $inc: { 'sellerStats.sold': 1 } }, { session });
        } else {
          await User.findByIdAndUpdate(
            escrow.sellerId,
            { $inc: { 'sellerStats.refunded': 1 } },
            { session }
          );
        }
      });
    } finally {
      await session.endSession();
    }

    await audit({
      actorId: opts.actorId ? new mongoose.Types.ObjectId(opts.actorId) : undefined,
      action: `escrow.${opts.ledgerType}`,
      targetType: 'EscrowHold',
      targetId: new mongoose.Types.ObjectId(escrowHoldId),
      after: {
        buyer: opts.buyerAmount,
        seller: opts.sellerAmount,
        platform: opts.platformAmount,
        period: opts.period,
      },
      note: opts.reason,
    });
  }

  /**
   * Arbitration outcome: an operator sets the split by hand. Used when the automatic policy
   * is not the right answer — a seller who proved the buyer took the account back, or a buyer
   * who proved the account was dead on arrival after the 24-hour window.
   */
  async settleByArbitration(
    escrowHoldId: string,
    split: { buyerAmount: number; sellerAmount: number; platformAmount: number },
    note: string,
    adminUserId: string
  ) {
    await this.settleEscrow(escrowHoldId, {
      ...split,
      escrowStatus: split.buyerAmount > 0 ? 'partial_refunded' : 'released',
      transactionStatus: split.buyerAmount > 0 ? 'refunded' : 'completed',
      productStatus: split.buyerAmount > 0 ? 'refunded' : 'sold',
      ledgerType: split.buyerAmount > 0 ? 'escrow_refund' : 'escrow_release',
      ledgerKey: `arbitration:${escrowHoldId}`,
      reason: note,
      period: 'arbitration',
      penaltyPercent: 0,
      actorId: adminUserId,
    });
  }

  /**
   * Tracks refunds in a rolling 30-day window. A buyer past the threshold keeps their money
   * this time but loses *automatic* refunds — the next one goes to a human. Refund farming
   * (buy, take the account, refund, repeat) is the main way a marketplace like this is bled
   * dry, and it only works if it is unattended.
   */
  private async recordBuyerRefund(buyerId: string) {
    const buyer = await User.findById(buyerId);
    if (!buyer) return;

    const windowStart = buyer.buyerStats?.refundWindowStartedAt;
    const windowExpired = !windowStart || Date.now() - windowStart.getTime() > 30 * 24 * 3600_000;

    if (windowExpired) {
      buyer.buyerStats.refundWindowStartedAt = new Date();
      buyer.buyerStats.refundsLast30d = 1;
    } else {
      buyer.buyerStats.refundsLast30d += 1;
    }
    buyer.buyerStats.refunded += 1;

    if (buyer.buyerStats.refundsLast30d >= config.refundAbuseThreshold) {
      buyer.refundAutoDisabled = true;
    }

    await buyer.save();
  }
}

/**
 * Timestamp from the SMS forwarder, which is a phone we do not control.
 *
 * `new Date(x)` happily returns an Invalid Date for anything it can't parse, and Mongoose then
 * rejects the whole insert — so one oddly-formatted timestamp from the gateway would make the
 * webhook 500 and a real, already-transferred payment would never be recorded. The arrival time
 * is metadata; it must never be able to block ingestion. Anything unparseable falls back to now.
 */
function parseReceivedAt(value?: string | number): Date {
  if (value === undefined || value === null || value === '') return new Date();

  // Bare digits are epoch seconds or milliseconds depending on the forwarder app.
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const fromEpoch = new Date(ms);
    return Number.isNaN(fromEpoch.getTime()) ? new Date() : fromEpoch;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.warn('[Payment] Unparseable received_at from SMS gateway, using arrival time:', value);
    return new Date();
  }
  return parsed;
}

function pickCard() {
  const cards = config.paymentCards;
  if (cards.length === 0) return null;
  // Spreading load across cards keeps any single card's daily turnover below the limits that
  // get personal cards frozen by the bank.
  return cards[Math.floor(Math.random() * cards.length)];
}

export const paymentService = new PaymentService();
export { calculateRefundAmount };
