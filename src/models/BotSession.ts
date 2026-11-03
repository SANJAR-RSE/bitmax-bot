import mongoose, { Schema, Document } from 'mongoose';

/**
 * Persistent storage for Telegraf's session/wizard state.
 *
 * Telegraf's default session store is a plain in-memory Map. A seller halfway through the
 * eight-step listing wizard lost everything on any restart or deploy, and the state could
 * not be shared once more than one bot replica exists. Persisting it here fixes both.
 */
export interface IBotSession extends Document {
  key: string;
  data: Record<string, unknown>;
  /** Abandoned wizards are swept by a TTL index rather than accumulating forever. */
  expiresAt: Date;
  updatedAt: Date;
}

const BotSessionSchema = new Schema<IBotSession>(
  {
    key: { type: String, required: true, unique: true },
    data: { type: Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

export const BotSession = mongoose.model<IBotSession>('BotSession', BotSessionSchema);

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Telegraf-compatible async session store backed by MongoDB. */
export const mongoSessionStore = {
  async get(key: string): Promise<Record<string, unknown> | undefined> {
    const doc = await BotSession.findOne({ key }).lean();
    return doc?.data as Record<string, unknown> | undefined;
  },
  async set(key: string, value: Record<string, unknown>): Promise<void> {
    await BotSession.findOneAndUpdate(
      { key },
      { $set: { data: value, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } },
      { upsert: true }
    );
  },
  async delete(key: string): Promise<void> {
    await BotSession.deleteOne({ key });
  },
};
