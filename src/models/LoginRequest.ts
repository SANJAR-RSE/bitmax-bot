import mongoose, { Schema, Document } from 'mongoose';

/**
 * One browser asking to be logged in, waiting for the owner of a Telegram account to approve
 * it from inside the bot — the same pairing shape as "WhatsApp Web", and the reason the site
 * needs no password of its own.
 *
 * Two details do the security work:
 *
 * 1. Only the SHA-256 of the token is stored. A database dump therefore cannot be replayed
 *    into a live session, exactly as with a password hash.
 * 2. `pairCode` is shown in the browser *and* in the bot's approval message. If somebody is
 *    phished into opening an attacker's login link, the codes will not match and the prompt
 *    says so — approval is a comparison, not a reflex tap.
 */
export interface ILoginRequest extends Document {
  tokenHash: string;
  pairCode: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  userId?: mongoose.Types.ObjectId;
  /** Truncated request metadata, shown in the bot so the user can recognise their own device. */
  ip?: string;
  userAgent?: string;
  approvedAt?: Date;
  consumedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
}

const LoginRequestSchema = new Schema<ILoginRequest>(
  {
    tokenHash: { type: String, required: true, unique: true },
    pairCode: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied', 'consumed'],
      default: 'pending',
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    ip: { type: String },
    userAgent: { type: String },
    approvedAt: { type: Date },
    consumedAt: { type: Date },
    // Unlike Transaction.expireAt (where a TTL delete destroyed the paper trail for money
    // that had already moved), nothing of value is recorded here: an unclaimed pairing
    // request is pure ephemera and should disappear on its own.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 900 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const LoginRequest = mongoose.model<ILoginRequest>('LoginRequest', LoginRequestSchema);
