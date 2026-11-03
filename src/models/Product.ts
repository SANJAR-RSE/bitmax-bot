import mongoose, { Schema, Document } from 'mongoose';
import { ProductStatus, ListingType } from '../types';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { config } from '../config';
import { nextListingCode } from './Sequence';

export interface ISensitiveData {
  login: string;
  password: string;
  recoveryCode?: string;
  additionalInfo?: string;
}

export interface IProduct extends Document {
  sellerId: mongoose.Types.ObjectId;
  listingCode?: string;
  title: string;
  description: string;
  price: number;
  category: string;
  subcategory?: string;

  /** Stored AES-256-GCM encrypted; use getCredentials() to read, setCredentials() to write. */
  sensitiveData: ISensitiveData;
  /** Set once credentials are wiped after the retention window. */
  credentialsPurgedAt?: Date;

  /**
   * `public` listings go through moderation into the catalog. `private` ones are a direct
   * deal between two people who already agreed — reachable only by `dealCode`, never listed.
   */
  listingType: ListingType;
  /** Human-typable code the seller hands to their agreed buyer. Only set for private deals. */
  dealCode?: string;
  /** Private deals that nobody claims are archived by the sweeper at this time. */
  dealExpiresAt?: Date;

  status: ProductStatus;
  moderationNote?: string;
  moderatedBy?: mongoose.Types.ObjectId;
  moderatedAt?: Date;

  images: string[];
  tags: string[];

  /**
   * Soft reservation held while a buyer's payment window runs, so two buyers can never
   * pay for the same account. Cleared by the expiry sweeper when the window lapses.
   */
  reservedBy?: mongoose.Types.ObjectId;
  reservedUntil?: Date;

  buyerId?: mongoose.Types.ObjectId;
  soldAt?: Date;
  viewCount: number;

  /** Seller-declared attributes shown in the catalog, e.g. followers, region, age. */
  attributes: Record<string, string>;

  createdAt: Date;
  updatedAt: Date;

  getCredentials(): ISensitiveData;
  setCredentials(data: ISensitiveData): void;
}

const ProductSchema = new Schema<IProduct>(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    listingCode: { type: String, unique: true, sparse: true, immutable: true, match: /^(?:[1-9]\d{5}|[A-Z][A-Z\d]{5})$/ },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    price: { type: Number, required: true, min: 1000 },
    category: { type: String, required: true, index: true },
    subcategory: { type: String },

    sensitiveData: {
      login: { type: String, required: true },
      password: { type: String, required: true },
      recoveryCode: { type: String },
      additionalInfo: { type: String },
    },
    credentialsPurgedAt: { type: Date },

    listingType: { type: String, enum: ['public', 'private'], default: 'public', index: true },
    // Sparse so the unique constraint applies only to deals that actually carry a code —
    // every public listing leaves this unset and they must not collide with each other.
    dealCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
    dealExpiresAt: { type: Date },

    status: {
      type: String,
      enum: [
        'draft',
        'pending_review',
        'rejected',
        'active',
        'reserved',
        'sold',
        'refunded',
        'disputed',
        'archived',
      ],
      default: 'pending_review',
      index: true,
    },
    moderationNote: { type: String },
    moderatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    moderatedAt: { type: Date },

    images: {
      type: [{ type: String }],
      default: [],
      validate: {
        // Bounded so a wizard bug (or a crafted API call, once one exists) can't attach an
        // unbounded number of photos to one listing — matches the same defense-in-depth
        // pattern as title/description/price above.
        validator: (arr: string[]) => arr.length <= config.maxProductImages,
        message: `Ko‘pi bilan ${config.maxProductImages} ta rasm mumkin`,
      },
    },
    tags: [{ type: String }],

    reservedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reservedUntil: { type: Date },

    buyerId: { type: Schema.Types.ObjectId, ref: 'User' },
    soldAt: { type: Date },
    viewCount: { type: Number, default: 0 },

    attributes: { type: Map, of: String, default: {} },
  },
  { timestamps: true }
);

// Catalog listing: active PUBLIC products by category, newest or cheapest first. listingType
// leads the key because every catalog query filters on it — a private deal must never surface.
ProductSchema.index({ listingType: 1, status: 1, category: 1, createdAt: -1 });
ProductSchema.index({ listingType: 1, status: 1, price: 1 });
// Unclaimed private deals, for the expiry sweeper.
ProductSchema.index({ listingType: 1, status: 1, dealExpiresAt: 1 });
// Text search across the buyer-visible fields, replacing the unindexed $regex scan.
ProductSchema.index({ title: 'text', description: 'text', tags: 'text' });
// Lets the sweeper find lapsed reservations cheaply.
ProductSchema.index({ status: 1, reservedUntil: 1 });

ProductSchema.pre('validate', async function () {
  if (this.isNew && !this.listingCode) this.listingCode = await nextListingCode();
});

ProductSchema.methods.setCredentials = function (this: IProduct, data: ISensitiveData) {
  this.sensitiveData = {
    login: encryptSecret(data.login),
    password: encryptSecret(data.password),
    recoveryCode: data.recoveryCode ? encryptSecret(data.recoveryCode) : undefined,
    additionalInfo: data.additionalInfo ? encryptSecret(data.additionalInfo) : undefined,
  };
};

ProductSchema.methods.getCredentials = function (this: IProduct): ISensitiveData {
  if (this.credentialsPurgedAt) {
    throw new Error('Credentials for this product have been purged after the retention window');
  }
  return {
    login: decryptSecret(this.sensitiveData?.login || ''),
    password: decryptSecret(this.sensitiveData?.password || ''),
    recoveryCode: this.sensitiveData?.recoveryCode
      ? decryptSecret(this.sensitiveData.recoveryCode)
      : undefined,
    additionalInfo: this.sensitiveData?.additionalInfo
      ? decryptSecret(this.sensitiveData.additionalInfo)
      : undefined,
  };
};

/**
 * Credentials must never travel in a serialized product, whatever its status. The previous
 * version of this hook inverted the condition and *kept* sensitiveData for sold/refunded
 * products, so any endpoint that returned a sold product handed out the account. There is
 * exactly one legitimate way to read them: getCredentials(), called from the escrow release
 * path after ownership has been verified.
 */
ProductSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.sensitiveData;
  return obj;
};

export const Product = mongoose.model<IProduct>('Product', ProductSchema);
