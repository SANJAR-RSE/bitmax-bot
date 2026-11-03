import mongoose, { Schema, Document } from 'mongoose';
import { TransactionStatus } from '../types';

export interface ITransaction extends Document {
  productId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;

  basePrice: number;
  expectedAmount: number;
  /** basePrice plus a random tail, which is what identifies the payer in the bank SMS. */
  uniqueAmount: number;
  /** Which of the configured cards the buyer was told to pay into. */
  cardId?: string;

  paymentProvider?: 'sms' | 'tezcheck';
  paymentUrl?: string;
  tezcheckBillId?: string;
  tezcheckRequest?: string;
  tezcheckPaymentId?: string;
  tezcheckAmountMinor?: number;
  tezcheckFeeMinor?: number;
  tezcheckNetMinor?: number;
  tezcheckCheckedAt?: Date;
  paymentReview?: string;
  paymentNotifiedAt?: Date;
  paymentReviewNotifiedAt?: Date;
  status: TransactionStatus;

  smsRawText?: string;
  smsConfirmedAt?: Date;
  paidAt?: Date;

  createdAt: Date;
  expireAt: Date;
  completedAt?: Date;
  cancelReason?: string;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    basePrice: { type: Number, required: true, min: 0 },
    expectedAmount: { type: Number, required: true, min: 0 },
    // Indexed below via the partial unique index instead of `index: true` here — a plain
    // field-level index plus a schema-level index on the same path is redundant and Mongoose
    // warns about it.
    uniqueAmount: { type: Number, required: true, min: 0 },
    cardId: { type: String },

    paymentProvider: { type: String, enum: ['sms', 'tezcheck'], default: 'sms' },
    paymentUrl: String,
    tezcheckBillId: String,
    tezcheckRequest: String,
    tezcheckPaymentId: String,
    tezcheckAmountMinor: Number,
    tezcheckFeeMinor: Number,
    tezcheckNetMinor: Number,
    tezcheckCheckedAt: Date,
    paymentReview: String,
    paymentNotifiedAt: Date,
    paymentReviewNotifiedAt: Date,
    status: {
      type: String,
      enum: ['pending_payment', 'paid', 'expired', 'cancelled', 'refunded', 'completed'],
      default: 'pending_payment',
      index: true,
    },

    smsRawText: { type: String },
    smsConfirmedAt: { type: Date },
    paidAt: { type: Date },

    /**
     * When the payment window closes. Deliberately NOT a TTL index: the previous schema had
     * `expireAfterSeconds: 0` here, which *deleted* the transaction the moment it expired.
     * A buyer whose transfer landed a minute late then had money in our account with no
     * record it was ever owed to anyone. The scheduler now flips the status to 'expired'
     * instead, and the row is kept for reconciliation.
     */
    expireAt: { type: Date, required: true },
    completedAt: { type: Date },
    cancelReason: { type: String },
  },
  { timestamps: true }
);

// DB-level guarantee (defense in depth on top of the retry loop in paymentService) that two
// transactions awaiting payment can never share a uniqueAmount, which would make an incoming
// SMS ambiguous about which buyer actually paid.
TransactionSchema.index(
  { uniqueAmount: 1 },
  { unique: true, partialFilterExpression: { status: 'pending_payment' } }
);

TransactionSchema.index({ tezcheckPaymentId: 1 }, { unique: true, sparse: true });
TransactionSchema.index({ tezcheckBillId: 1 }, { unique: true, sparse: true });

// The expiry sweeper scans exactly this shape.
TransactionSchema.index({ status: 1, expireAt: 1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
