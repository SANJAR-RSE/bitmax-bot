import crypto from 'crypto';
import { User, IUser } from '../models/User';
import { Product } from '../models/Product';
import { Transaction } from '../models/Transaction';
import { EscrowHold } from '../models/EscrowHold';
import { paymentService } from './paymentService';
import { config } from '../config';
import { generateDealCode, normalizeDealCode } from '../utils/helpers';

export class BlockedUserError extends Error {
  constructor(reason?: string) {
    super(reason || 'Hisobingiz bloklangan');
    this.name = 'BlockedUserError';
  }
}

export class BotApiService {
  async getOrCreateUser(telegramId: number, ctx: any): Promise<IUser> {
    const from = ctx.from || {};

    // Upsert so two updates arriving at once for a brand-new user can't create duplicates.
    const user = await User.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          username: from.username,
          firstName: from.first_name,
          lastName: from.last_name,
          lastSeenAt: new Date(),
        },
        $setOnInsert: {
          role: 'buyer',
          language: from.language_code === 'ru' ? 'ru' : 'uz',
          referralCode: crypto.randomBytes(4).toString('hex'),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return user;
  }

  /**
   * Every entry point calls this. `isBlocked` existed in v1 but was never checked anywhere,
   * so blocking a scammer changed a boolean and nothing else — they kept trading.
   */
  assertNotBlocked(user: IUser) {
    if (user.isBlocked) throw new BlockedUserError(user.blockReason);
  }

  async createProduct(data: {
    productId?: string;
    sellerId: string;
    title: string;
    description: string;
    price: number;
    category: string;
    login: string;
    password: string;
    recoveryCode?: string;
    additionalInfo?: string;
    tags?: string[];
    images?: string[];
  }) {
    if (data.productId) {
      const existing = await Product.findOne({ _id: data.productId, sellerId: data.sellerId });
      if (existing) return existing;
    }
    const product = new Product({
      ...(data.productId ? { _id: data.productId } : {}),
      sellerId: data.sellerId,
      title: data.title,
      description: data.description,
      price: data.price,
      category: data.category,
      tags: data.tags || [],
      images: data.images || [],
      // Seller reviews the listing before confirming publication.
      status: 'active',
    });

    // Goes through the model method so credentials are encrypted before they ever touch disk.
    product.setCredentials({
      login: data.login,
      password: data.password,
      recoveryCode: data.recoveryCode,
      additionalInfo: data.additionalInfo,
    });

    try { await product.save(); } catch (error: any) {
      if (error?.code === 11000 && data.productId) {
        const existing = await Product.findOne({ _id: data.productId, sellerId: data.sellerId });
        if (existing) return existing;
      }
      throw error;
    }
    await User.findByIdAndUpdate(data.sellerId, { $inc: { 'sellerStats.listed': 1 } });

    return product;
  }

  /**
   * Creates a private escrow deal: no catalog listing, no moderation, reachable only by the
   * code the seller passes to the one buyer they already agreed with.
   *
   * Moderation is skipped deliberately. Its job is to protect strangers browsing a catalog
   * from a fake listing; here there is no stranger — the buyer chose this seller and this
   * account before Bitmax was involved, and all they want is the escrow in the middle.
   */
  async createDeal(data: {
    sellerId: string;
    title: string;
    price: number;
    description?: string;
    category?: string;
    login: string;
    password: string;
    recoveryCode?: string;
    images?: string[];
  }) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dealCode = generateDealCode();
      const product = new Product({
        sellerId: data.sellerId,
        title: data.title,
        description: data.description || `Kelishilgan bitim: ${data.title}`,
        price: data.price,
        category: data.category || 'Boshqa',
        images: data.images || [],
        listingType: 'private',
        dealCode,
        // An unclaimed code shouldn't stay live forever — the seller's credentials are sitting
        // in it. A week is long enough for any real handover.
        dealExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        status: 'active',
      });

      product.setCredentials({
        login: data.login,
        password: data.password,
        recoveryCode: data.recoveryCode,
      });

      try {
        await product.save();
        await User.findByIdAndUpdate(data.sellerId, { $inc: { 'sellerStats.listed': 1 } });
        return product;
      } catch (err: any) {
        // E11000 = the generated code collided with an existing one; draw another.
        if (err?.code === 11000) continue;
        throw err;
      }
    }
    throw new Error('Bitim kodini yaratib bo‘lmadi, qayta urinib ko‘ring');
  }

  /** Resolves a buyer-typed code to a live deal. Returns null for anything not purchasable. */
  async findDealByCode(code: string) {
    const normalized = normalizeDealCode(code);
    if (normalized.length !== 8) return null;

    return Product.findOne({
      dealCode: normalized,
      listingType: 'private',
      status: { $in: ['active', 'reserved'] },
    }).populate('sellerId', 'telegramId username trustLevel sellerStats');
  }

  /** Seller cancels their own unclaimed deal, invalidating the code. */
  async cancelDeal(productId: string, sellerId: string) {
    return this.cancelListing(productId, sellerId);
  }

  async cancelListing(productId: string, sellerId: string) {
    return Product.findOneAndUpdate(
      { _id: productId, sellerId, status: { $in: ['active', 'pending_review', 'draft', 'rejected'] } },
      { $set: { status: 'archived' }, $unset: { dealCode: '' } },
      { new: true }
    );
  }

  async getActiveProducts(page = 1, limit = 10, category?: string) {
    // Public catalog only — a private deal is reachable by its code and nowhere else.
    const filter: Record<string, unknown> = { status: 'active', listingType: 'public' };
    if (category) filter.category = category;

    const total = await Product.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    page = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1));
    const products = await Product.find(filter)
        .select('-sensitiveData')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('sellerId', 'telegramId username trustLevel sellerStats');

    return { products, total, pages, page };
  }

  async getUserProducts(userId: string) {
    return Product.find({ sellerId: userId }).select('-sensitiveData').sort('-createdAt').limit(50);
  }

  async getUserTransactions(userId: string, role: 'buyer' | 'seller') {
    const filter = role === 'buyer' ? { buyerId: userId } : { sellerId: userId };
    return Transaction.find(filter).sort('-createdAt').limit(50).populate('productId', 'title price');
  }

  async getEscrowHolds(userId: string, role: 'buyer' | 'seller') {
    const filter = role === 'buyer' ? { buyerId: userId } : { sellerId: userId };
    return EscrowHold.find(filter).sort('-createdAt').limit(50).populate('productId', 'title price');
  }

  /**
   * Opens a purchase. The reservation and the unique-amount allocation both live in
   * paymentService, which is also where the product-availability check happens atomically —
   * checking here first would only add a race window.
   */
  async initiatePurchase(productId: string, buyerId: string) {
    return paymentService.createPaymentTransaction(productId, buyerId);
  }

  supportLink(): string {
    return `https://t.me/${config.supportUsername}`;
  }
}

export const botApi = new BotApiService();
