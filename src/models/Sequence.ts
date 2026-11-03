import mongoose, { Schema } from 'mongoose';
import { listingCodeFromSequence } from '../utils/listingCode';
const Sequence = mongoose.model('Sequence', new Schema({ _id: String, value: { type: Number, default: 0 } }));

export async function nextListingCode(): Promise<string> {
  // The _id index serializes concurrent upserts, including the very first allocation.
  let counter;
  try {
    counter = await Sequence.findOneAndUpdate({ _id: 'listing-code' }, { $inc: { value: 1 } }, { upsert: true, new: true });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    counter = await Sequence.findOneAndUpdate({ _id: 'listing-code' }, { $inc: { value: 1 } }, { new: true });
  }
  if (!counter) throw new Error('Listing code could not be allocated');
  return listingCodeFromSequence(counter.value!);
}
