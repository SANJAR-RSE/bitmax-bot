import { Product } from '../models/Product';
import { nextListingCode } from '../models/Sequence';

/** Add codes to legacy records without altering their status, price or credentials. */
export async function backfillListingCodes(): Promise<void> {
  await Product.init();
  for await (const product of Product.find({ listingCode: { $exists: false } }).select('_id').cursor()) {
    const code = await nextListingCode();
    await Product.updateOne({ _id: product._id, listingCode: { $exists: false } }, { $set: { listingCode: code } }, { overwriteImmutable: true });
  }
}
