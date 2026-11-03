import mongoose, { Schema } from 'mongoose';

// Stable body ID, independent of delivery/header IDs. Durable queue survives restarts.
const schema = new Schema({
  eventId: { type: String, required: true, unique: true },
  payload: { type: Schema.Types.Mixed, required: true },
  processedAt: Date,
  review: String,
  attemptedAt: Date,
}, { timestamps: true });
schema.index({ processedAt: 1, attemptedAt: 1 });
export const TezcheckEvent = mongoose.model('TezcheckEvent', schema);
