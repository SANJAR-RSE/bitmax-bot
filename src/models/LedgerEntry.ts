import mongoose, { Schema, Document } from 'mongoose';

/**
 * Immutable double-entry journal.
 *
 * Before this existed, balances moved via ad-hoc `$inc` on the User document, which means
 * a bug or a partially-applied operation left a wrong number with no way to find out what
 * happened. Here every movement of money is one journal entry whose postings sum to zero,
 * and a user's balance is a *derivable* fact rather than a mutable counter. `User.balance`
 * is kept as a cache of this and reconciled by a scheduled job.
 *
 * Nothing ever updates or deletes an entry — a correction is a new, opposite entry.
 */

export type LedgerEntryType =
  | 'payment_received' // buyer's bank transfer landed, funds enter escrow
  | 'escrow_release' // escrow settles to seller + platform
  | 'escrow_refund' // escrow settles back to buyer (minus any penalty split)
  | 'payout_reserved' // user requested a withdrawal; funds leave available balance
  | 'payout_paid' // withdrawal actually sent to the user's card
  | 'payout_reverted' // withdrawal rejected/failed, funds returned to available
  | 'manual_adjustment'; // admin correction, always with a reason in meta

export interface IPosting {
  /** Canonical account id, e.g. `user:<id>:available`, `escrow:<holdId>`, `platform:revenue`. */
  account: string;
  /** Signed minor-unit amount. Positive = credit (account gains), negative = debit. */
  amount: number;
}

export interface ILedgerEntry extends Document {
  /**
   * Caller-supplied idempotency key, unique across the collection. Replaying the same
   * business event (a duplicate webhook, a retried job) collides here and is a no-op
   * instead of double-crediting someone.
   */
  key: string;
  type: LedgerEntryType;
  currency: string;
  postings: IPosting[];
  refType?: string;
  refId?: mongoose.Types.ObjectId;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const PostingSchema = new Schema<IPosting>(
  {
    account: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

const LedgerEntrySchema = new Schema<ILedgerEntry>(
  {
    key: { type: String, required: true, unique: true },
    type: { type: String, required: true, index: true },
    currency: { type: String, required: true, default: 'UZS' },
    postings: {
      type: [PostingSchema],
      required: true,
      validate: {
        validator: (postings: IPosting[]) =>
          postings.length >= 2 && postings.reduce((sum, p) => sum + p.amount, 0) === 0,
        message: 'Ledger postings must contain at least two legs and sum to exactly zero',
      },
    },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Balance lookups filter by account across the postings array.
LedgerEntrySchema.index({ 'postings.account': 1, createdAt: -1 });
LedgerEntrySchema.index({ refType: 1, refId: 1 });

export const LedgerEntry = mongoose.model<ILedgerEntry>('LedgerEntry', LedgerEntrySchema);
