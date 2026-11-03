import { config, RefundTier } from '../config';
import { RefundQuote } from '../types';

/**
 * Refund and commission arithmetic.
 *
 * The previous implementation subtracted the platform commission from the buyer's refund on
 * top of the penalty: a "10% penalty, 90% back to you" message actually returned 83%, and a
 * "full refund" returned 93%. Telling a buyer one number and moving another is the fastest
 * way to lose a marketplace's reputation, so the model here is defined the other way round —
 * the buyer's share is the fixed promise, and the platform's cut is taken only from what the
 * buyer forfeits:
 *
 *   penaltyPool  = amount × penaltyPercent
 *   refundToBuyer = amount − penaltyPool        ← exactly what the message says
 *   platformKeeps = penaltyPool × commission
 *   sellerKeeps   = penaltyPool − platformKeeps
 *
 * The platform therefore earns commission only on value that actually settles, and a
 * cancelled sale costs the buyer nothing beyond the stated penalty. Every branch is checked
 * by the invariant test in refundEngine.test.ts: the four shares always sum to the amount.
 */

export interface PayoutSplit {
  commission: number;
  sellerPayout: number;
}

function tiers(): RefundTier[] {
  return config.refundTiers;
}

/** The tier whose window the elapsed time falls into. The final tier is the catch-all. */
export function resolveTier(elapsedMinutes: number): RefundTier {
  const table = tiers();
  for (const tier of table) {
    if (tier.withinMinutes === null) return tier;
    if (elapsedMinutes <= tier.withinMinutes) return tier;
  }
  return table[table.length - 1];
}

/** Latest moment a refund is still possible, measured from the start of the clock. */
export function refundDeadlineFrom(start: Date): Date {
  const lastAllowed = [...tiers()].reverse().find((t) => t.allowed && t.withinMinutes !== null);
  const minutes = lastAllowed?.withinMinutes ?? 0;
  return new Date(start.getTime() + minutes * 60 * 1000);
}

/** Split of a fully settled order: what the seller receives and what the platform earns. */
export function calculateSellerPayout(amount: number): PayoutSplit {
  const commission = Math.round((amount * config.platformCommission) / 100);
  return { commission, sellerPayout: amount - commission };
}

/**
 * Splits `amount` for a refund at `penaltyPercent`. Exported separately from the quote so the
 * arithmetic can be tested and reused by arbitration, which sets the penalty by hand.
 */
export function calculateRefundAmount(
  amount: number,
  penaltyPercent: number,
  platformCommission: number = config.platformCommission
): {
  penaltyAmount: number;
  refundToBuyer: number;
  platformKeeps: number;
  sellerKeeps: number;
} {
  const penaltyAmount = Math.round((amount * penaltyPercent) / 100);
  const refundToBuyer = amount - penaltyAmount;
  const platformKeeps = Math.round((penaltyAmount * platformCommission) / 100);
  const sellerKeeps = penaltyAmount - platformKeeps;

  return { penaltyAmount, refundToBuyer, platformKeeps, sellerKeeps };
}

export interface QuoteOptions {
  /**
   * When the buyer actually received the credentials. Falls back to the purchase time only
   * if the reveal never happened — in which case nothing was delivered and the refund is
   * unconditionally full.
   */
  revealedAt?: Date | null;
  boughtAt: Date;
  amount: number;
  now?: Date;
  /** Buyer flagged for refund abuse: quote is produced but routed to a human. */
  requiresArbitration?: boolean;
}

export function quoteRefund(options: QuoteOptions): RefundQuote {
  const now = options.now ?? new Date();
  const { amount, boughtAt, revealedAt } = options;

  // Nothing was ever delivered — the buyer holds no goods, so there is no penalty to justify.
  if (!revealedAt) {
    return {
      allowed: true,
      period: 'not_revealed',
      label: 'Ma’lumotlar ochilmagan',
      penaltyPercent: 0,
      refundToBuyer: amount,
      penaltyAmount: 0,
      platformKeeps: 0,
      sellerKeeps: 0,
      elapsedMinutes: minutesBetween(boughtAt, now),
      requiresArbitration: false,
      message:
        'Akkaunt ma’lumotlari sizga hali ochilmagan, shuning uchun pul 100% qaytariladi.',
    };
  }

  const elapsedMinutes = minutesBetween(revealedAt, now);
  const tier = resolveTier(elapsedMinutes);

  if (!tier.allowed) {
    return {
      allowed: false,
      period: tier.id,
      label: tier.label,
      penaltyPercent: 100,
      refundToBuyer: 0,
      penaltyAmount: amount,
      platformKeeps: calculateSellerPayout(amount).commission,
      sellerKeeps: calculateSellerPayout(amount).sellerPayout,
      elapsedMinutes,
      requiresArbitration: false,
      message:
        'Ma’lumotlarni olganingizdan 24 soat o’tgani sababli avtomatik qaytarish mumkin emas. ' +
        'Agar jiddiy muammo bo’lsa, nizo (dispute) ochishingiz mumkin.',
    };
  }

  const split = calculateRefundAmount(amount, tier.penaltyPercent);

  return {
    allowed: true,
    period: tier.id,
    label: tier.label,
    penaltyPercent: tier.penaltyPercent,
    ...split,
    elapsedMinutes,
    requiresArbitration: Boolean(options.requiresArbitration),
    message: buildMessage(tier, split.refundToBuyer, amount),
  };
}

function buildMessage(tier: RefundTier, refundToBuyer: number, amount: number): string {
  const percentBack = Math.round((refundToBuyer / amount) * 100);
  if (tier.penaltyPercent === 0) {
    return `${tier.label} ichida qaytaryapsiz — summa 100% (${refundToBuyer.toLocaleString()} UZS) qaytariladi.`;
  }
  return (
    `${tier.label} oralig’ida qaytaryapsiz — ${tier.penaltyPercent}% jarima ushlanadi. ` +
    `Sizga ${percentBack}% (${refundToBuyer.toLocaleString()} UZS) qaytariladi.`
  );
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000));
}

/** Human-readable policy table for help screens and the web FAQ. */
export function describeRefundPolicy(): string {
  return tiers()
    .map((tier) => {
      if (!tier.allowed) return `• ${tier.label}: qaytarish mumkin emas`;
      if (tier.penaltyPercent === 0) return `• ${tier.label}: 100% qaytariladi`;
      return `• ${tier.label}: ${100 - tier.penaltyPercent}% qaytariladi (${tier.penaltyPercent}% jarima)`;
    })
    .join('\n');
}
