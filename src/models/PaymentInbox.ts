import mongoose, { Schema, Document } from 'mongoose';
import { PaymentInboxStatus } from '../types';

/**
 * Every inbound bank SMS, matched or not.
 *
 * The original webhook parsed an SMS, failed to find a matching pending transaction, and
 * returned `{ success: false }` — discarding it. But the money had already arrived in the
 * bank account. Any late transfer, mistyped amount, or SMS that landed after the 10-minute
 * window became a silent loss that nobody could even discover afterwards.
 *
 * Now nothing is discarded: unmatched messages queue here for an operator to resolve, and
 * the hash makes redelivery of the same SMS a no-op.
 */
export interface IPaymentInbox extends Document {
  rawText: string;
  /** sha256 of sender + text + bank timestamp, so a redelivered SMS is recognised. */
  hash: string;
  sender?: string;
  parsedAmount?: number;
  receivedAt: Date;

  status: PaymentInboxStatus;
  transactionId?: mongoose.Types.ObjectId;

  /** Operator follow-up for messages that could not be matched automatically. */
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolutionNote?: string;
  /** Muting reminders does not resolve or discard the payment. */
  reminderMuted?: boolean;
  reminderChangedBy?: mongoose.Types.ObjectId;
  reminderChangedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const PaymentInboxSchema = new Schema<IPaymentInbox>(
  {
    rawText: { type: String, required: true, maxlength: 2000 },
    hash: { type: String, required: true, unique: true },
    sender: { type: String },
    parsedAmount: { type: Number },
    receivedAt: { type: Date, required: true, default: Date.now },

    status: {
      type: String,
      enum: ['matched', 'unmatched', 'duplicate', 'ignored', 'resolved'],
      required: true,
      index: true,
    },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },

    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    resolutionNote: { type: String },
    reminderMuted: { type: Boolean, default: false },
    reminderChangedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reminderChangedAt: Date,
  },
  { timestamps: true }
);

// Operator queue: oldest unresolved first.
PaymentInboxSchema.index({ status: 1, receivedAt: 1 });
// Finding a near-miss by amount is the first thing an operator does when resolving.
PaymentInboxSchema.index({ parsedAmount: 1, receivedAt: -1 });

export const PaymentInbox = mongoose.model<IPaymentInbox>('PaymentInbox', PaymentInboxSchema);
