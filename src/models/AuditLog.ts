import mongoose, { Schema, Document } from 'mongoose';

/**
 * Append-only record of privileged actions: blocking a user, resolving a dispute, approving
 * a payout, revealing credentials, adjusting a balance.
 *
 * On a platform where one operator can move another person's money, "who did this and when"
 * has to be answerable months later. Nothing here is ever updated or deleted.
 */
export interface IAuditLog extends Document {
  actorId?: mongoose.Types.ObjectId;
  actorTelegramId?: number;
  /** Dotted action name, e.g. `payout.approve`, `user.block`, `escrow.credentials_revealed`. */
  action: string;
  targetType?: string;
  targetId?: mongoose.Types.ObjectId;
  /** Small before/after snapshots — never full documents, never credentials. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
  ip?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorTelegramId: { type: Number },
    action: { type: String, required: true, index: true },
    targetType: { type: String },
    targetId: { type: Schema.Types.ObjectId },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    note: { type: String },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

/** Fire-and-forget helper: an audit write must never break the action it records. */
export async function audit(entry: Partial<IAuditLog>): Promise<void> {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    console.error('[Audit] Failed to write audit entry:', err);
  }
}
