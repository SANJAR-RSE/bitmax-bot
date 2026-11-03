import mongoose, { Schema, Document } from 'mongoose';
import { PayoutStatus } from '../types';

/**
 * Withdrawal of an available balance to a bank card.
 *
 * Without this, "the buyer is refunded" only ever meant a number in our own database went
 * up — the user could never get their money back out. Funds are moved out of the available
 * balance at request time (reserved), so the same balance cannot be withdrawn twice while
 * an operator works through the queue.
 */
export interface IPayout extends Document {
  userId: mongoose.Types.ObjectId;
  amount: number;
  fee: number;
  netAmount: number;

  /** Snapshot of the destination at request time, so later card edits don't rewrite history. */
  destinationMasked: string;
  destinationEncrypted: string;
  destinationHolder?: string;

  status: PayoutStatus;
  requestedAt: Date;
  processedAt?: Date;
  processedBy?: mongoose.Types.ObjectId;
  /** Bank reference / receipt id an operator pastes in after sending the transfer. */
  externalReference?: string;
  note?: string;

  createdAt: Date;
  updatedAt: Date;
}

const PayoutSchema = new Schema<IPayout>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    fee: { type: Number, required: true, default: 0, min: 0 },
    netAmount: { type: Number, required: true, min: 0 },

    destinationMasked: { type: String, required: true },
    destinationEncrypted: { type: String, required: true },
    destinationHolder: { type: String },

    status: {
      type: String,
      enum: ['requested', 'approved', 'processing', 'paid', 'rejected', 'failed'],
      default: 'requested',
      index: true,
    },
    requestedAt: { type: Date, required: true, default: Date.now },
    processedAt: { type: Date },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    externalReference: { type: String },
    note: { type: String },
  },
  { timestamps: true }
);

// Operator queue: oldest pending request first.
PayoutSchema.index({ status: 1, requestedAt: 1 });

// Never let the encrypted destination leave through an API response.
PayoutSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.destinationEncrypted;
  return obj;
};

export const Payout = mongoose.model<IPayout>('Payout', PayoutSchema);
