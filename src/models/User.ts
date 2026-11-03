import mongoose, { Schema, Document } from 'mongoose';
import { UserRole, Language, TrustLevel } from '../types';

export interface IUser extends Document {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  language: Language;
  role: UserRole;

  /**
   * Cached mirror of the ledger balance for `user:<id>:available`. The ledger is the source
   * of truth; a scheduled job reconciles any drift. Reads are allowed to use this, writes
   * must go through ledgerService.postAndSync.
   */
  balance: number;
  totalEarned: number;
  totalSpent: number;

  /**
   * Trust gates what a seller may do. New sellers are limited (low price ceiling, fewer
   * concurrent listings) until they have settled orders without disputes — this is what
   * makes it uneconomic to sign up, dump fake accounts, and disappear.
   */
  trustLevel: TrustLevel;
  sellerStats: {
    listed: number;
    sold: number;
    refunded: number;
    disputesLost: number;
    ratingSum: number;
    ratingCount: number;
  };
  buyerStats: {
    purchased: number;
    refunded: number;
    /** Rolling 30-day refund count, used to detect refund farming. */
    refundsLast30d: number;
    refundWindowStartedAt?: Date;
  };

  /** Encrypted destination card for withdrawals, plus a display-safe masked form. */
  payoutCard?: {
    encrypted: string;
    masked: string;
    holder: string;
    updatedAt: Date;
  };

  isBlocked: boolean;
  blockReason?: string;
  /**
   * Sessions issued before this moment are refused. "Log out everywhere" is one write here,
   * which is what makes a stateless session token revocable without a session table.
   */
  webSessionsValidFrom?: Date;
  /** Automatic refunds are disabled for this user; refunds go to manual arbitration. */
  refundAutoDisabled: boolean;

  referralCode: string;
  referredBy?: mongoose.Types.ObjectId;

  notificationSettings: {
    newOrder: boolean;
    paymentConfirm: boolean;
    refundUpdate: boolean;
    promo: boolean;
  };

  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;

  averageRating(): number | null;
}

const UserSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true },
    username: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    language: { type: String, enum: ['uz', 'ru', 'en'], default: 'uz' },
    role: {
      type: String,
      enum: ['buyer', 'seller', 'admin', 'moderator'],
      default: 'buyer',
      index: true,
    },

    balance: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },

    trustLevel: { type: String, enum: ['new', 'verified', 'trusted', 'partner'], default: 'new' },
    sellerStats: {
      listed: { type: Number, default: 0 },
      sold: { type: Number, default: 0 },
      refunded: { type: Number, default: 0 },
      disputesLost: { type: Number, default: 0 },
      ratingSum: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
    },
    buyerStats: {
      purchased: { type: Number, default: 0 },
      refunded: { type: Number, default: 0 },
      refundsLast30d: { type: Number, default: 0 },
      refundWindowStartedAt: { type: Date },
    },

    payoutCard: {
      encrypted: { type: String },
      masked: { type: String },
      holder: { type: String },
      updatedAt: { type: Date },
    },

    isBlocked: { type: Boolean, default: false, index: true },
    blockReason: { type: String },
    webSessionsValidFrom: { type: Date },
    refundAutoDisabled: { type: Boolean, default: false },

    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },

    notificationSettings: {
      newOrder: { type: Boolean, default: true },
      paymentConfirm: { type: Boolean, default: true },
      refundUpdate: { type: Boolean, default: true },
      promo: { type: Boolean, default: false },
    },

    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.methods.averageRating = function (this: IUser): number | null {
  if (!this.sellerStats?.ratingCount) return null;
  return Math.round((this.sellerStats.ratingSum / this.sellerStats.ratingCount) * 10) / 10;
};

// Never let a raw payout card ciphertext escape through an API response.
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  if (obj.payoutCard?.encrypted) delete obj.payoutCard.encrypted;
  return obj;
};

export const User = mongoose.model<IUser>('User', UserSchema);
