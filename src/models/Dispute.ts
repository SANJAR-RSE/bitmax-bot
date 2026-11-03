import mongoose, { Schema, Document } from 'mongoose';
import { DisputeStatus } from '../types';

export interface IEvidence {
  kind: 'text' | 'photo' | 'video' | 'file';
  /** Telegram file_id or a storage URL. */
  ref?: string;
  note?: string;
  addedBy: mongoose.Types.ObjectId;
  addedAt: Date;
}

/**
 * Arbitration case over an escrow hold.
 *
 * The original design had refunds only: the buyer pressed a button and money moved, with
 * the seller having no say. For a marketplace selling accounts — where the buyer is told to
 * change the password the moment they receive it — that is a standing invitation to take the
 * account and the money. A dispute gives the seller a window to present evidence, and an
 * operator the record to decide on.
 */
export interface IDispute extends Document {
  escrowHoldId: mongoose.Types.ObjectId;
  transactionId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;

  openedBy: mongoose.Types.ObjectId;
  category:
    | 'not_working'
    | 'wrong_info'
    | 'already_recovered' // the original owner pulled the account back
    | 'seller_fraud'
    | 'buyer_fraud'
    | 'other';
  reason: string;
  amount: number;

  status: DisputeStatus;
  evidence: IEvidence[];

  /** How long the counterparty has to respond before an operator decides without them. */
  responseDueAt: Date;
  slaDueAt: Date;

  resolution?: {
    buyerAmount: number;
    sellerAmount: number;
    platformAmount: number;
    note: string;
    decidedBy: mongoose.Types.ObjectId;
    decidedAt: Date;
  };

  createdAt: Date;
  updatedAt: Date;
}

const EvidenceSchema = new Schema<IEvidence>(
  {
    kind: { type: String, enum: ['text', 'photo', 'video', 'file'], required: true },
    ref: { type: String },
    note: { type: String, maxlength: 2000 },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DisputeSchema = new Schema<IDispute>(
  {
    escrowHoldId: { type: Schema.Types.ObjectId, ref: 'EscrowHold', required: true, index: true },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    openedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: {
      type: String,
      enum: ['not_working', 'wrong_info', 'already_recovered', 'seller_fraud', 'buyer_fraud', 'other'],
      required: true,
    },
    reason: { type: String, required: true, maxlength: 2000 },
    amount: { type: Number, required: true },

    status: {
      type: String,
      enum: ['open', 'under_review', 'resolved_buyer', 'resolved_seller', 'resolved_split', 'cancelled'],
      default: 'open',
      index: true,
    },
    evidence: [EvidenceSchema],

    responseDueAt: { type: Date, required: true },
    slaDueAt: { type: Date, required: true },

    resolution: {
      buyerAmount: { type: Number },
      sellerAmount: { type: Number },
      platformAmount: { type: Number },
      note: { type: String },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
    },
  },
  { timestamps: true }
);

// Operator queue: breaching-soonest first.
DisputeSchema.index({ status: 1, slaDueAt: 1 });

export const Dispute = mongoose.model<IDispute>('Dispute', DisputeSchema);
