import mongoose, { Schema, Document } from 'mongoose';
import { EscrowStatus } from '../types';

export interface IRefundLog {
  action: 'requested' | 'approved' | 'rejected' | 'partial' | 'arbitration';
  period: string;
  penaltyPercent: number;
  refundAmount: number;
  reason?: string;
  actorId?: mongoose.Types.ObjectId;
  processedAt: Date;
}

export interface IEscrowHold extends Document {
  transactionId: mongoose.Types.ObjectId;
  buyerId: mongoose.Types.ObjectId;
  sellerId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;

  amount: number;
  commission: number;
  sellerPayout: number;

  status: EscrowStatus;
  boughtAt: Date;

  /**
   * When the buyer actually saw the login and password.
   *
   * This — not boughtAt — is what the refund clock runs from. Payment confirmation is
   * automatic and can land while the buyer is asleep; charging them a 50% penalty for time
   * they never had the goods would be indefensible. It also means an order whose credentials
   * were never revealed is always fully refundable.
   */
  credentialsRevealedAt?: Date;
  credentialRevealCount: number;

  /** Escrow settles to the seller automatically at this time if the buyer never acts. */
  autoReleaseAt: Date;
  /** Last moment a refund can be requested; derived from the final refund tier. */
  refundDeadlineAt: Date;

  confirmedAt?: Date;
  refundReason?: string;
  refundPeriod?: string;
  refundLog: IRefundLog[];

  disputeId?: mongoose.Types.ObjectId;
  buyerRating?: number;

  createdAt: Date;
  updatedAt: Date;
}

const RefundLogSchema = new Schema<IRefundLog>(
  {
    action: {
      type: String,
      enum: ['requested', 'approved', 'rejected', 'partial', 'arbitration'],
      required: true,
    },
    period: { type: String, required: true },
    penaltyPercent: { type: Number, required: true },
    refundAmount: { type: Number, required: true },
    reason: { type: String },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    processedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const EscrowHoldSchema = new Schema<IEscrowHold>(
  {
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },

    amount: { type: Number, required: true },
    commission: { type: Number, required: true },
    sellerPayout: { type: Number, required: true },

    status: {
      type: String,
      enum: ['holding', 'released', 'refunded', 'partial_refunded', 'disputed'],
      default: 'holding',
      index: true,
    },
    boughtAt: { type: Date, required: true },

    credentialsRevealedAt: { type: Date },
    credentialRevealCount: { type: Number, default: 0 },

    autoReleaseAt: { type: Date, required: true },
    refundDeadlineAt: { type: Date, required: true },

    confirmedAt: { type: Date },
    refundReason: { type: String },
    refundPeriod: { type: String },
    refundLog: [RefundLogSchema],

    disputeId: { type: Schema.Types.ObjectId, ref: 'Dispute' },
    buyerRating: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true }
);

// The auto-release sweeper scans exactly this shape.
EscrowHoldSchema.index({ status: 1, autoReleaseAt: 1 });

export const EscrowHold = mongoose.model<IEscrowHold>('EscrowHold', EscrowHoldSchema);
