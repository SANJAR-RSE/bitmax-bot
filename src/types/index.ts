export type UserRole = 'buyer' | 'seller' | 'admin' | 'moderator';
export type Language = 'uz' | 'ru' | 'en';
export type TrustLevel = 'new' | 'verified' | 'trusted' | 'partner';

/**
 * How a listing reaches its buyer.
 *
 * `public` — the marketplace flow: moderated, listed in the catalog, any buyer can purchase.
 * `private` — the two parties already agreed elsewhere and only want the escrow. The seller
 *   gets a deal code to hand to that one buyer; nothing is ever shown in the catalog and no
 *   moderation is needed, because there is no stranger to protect from the listing.
 */
export type ListingType = 'public' | 'private';

export type ProductStatus =
  | 'draft' // seller is still filling it in
  | 'pending_review' // waiting for moderation
  | 'rejected' // moderation refused it
  | 'active' // listed and buyable
  | 'reserved' // a buyer holds it while their payment window runs
  | 'sold'
  | 'refunded'
  | 'disputed'
  | 'archived';

export type TransactionStatus =
  | 'pending_payment'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'completed';

export type EscrowStatus = 'holding' | 'released' | 'refunded' | 'partial_refunded' | 'disputed';

export type DisputeStatus =
  | 'open'
  | 'under_review'
  | 'resolved_buyer'
  | 'resolved_seller'
  | 'resolved_split'
  | 'cancelled';

export type PayoutStatus = 'requested' | 'approved' | 'processing' | 'paid' | 'rejected' | 'failed';

export type PaymentInboxStatus = 'matched' | 'unmatched' | 'duplicate' | 'ignored' | 'resolved';

export interface RefundQuote {
  allowed: boolean;
  /** Tier id from config.refundTiers, e.g. '0-10min'. */
  period: string;
  label: string;
  penaltyPercent: number;
  /** Exactly what the buyer receives back. */
  refundToBuyer: number;
  /** Total forfeited by the buyer (split between seller and platform). */
  penaltyAmount: number;
  /** Platform's cut of the penalty pool. */
  platformKeeps: number;
  /** Seller's compensation out of the penalty pool. */
  sellerKeeps: number;
  /** Minutes elapsed on the clock the quote was computed against. */
  elapsedMinutes: number;
  requiresArbitration: boolean;
  message: string;
}

export interface PaymentInfo {
  expectedAmount: number;
  uniqueAmount: number;
  cardNumber?: string;
  cardHolder?: string;
  bankName?: string;
  expiresAt: Date;
}
