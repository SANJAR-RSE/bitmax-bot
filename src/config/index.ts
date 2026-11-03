import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value;
  if (isProd) {
    // Fail closed in production instead of silently running with a weak/default secret.
    throw new Error(`[Config] Missing required environment variable: ${name}`);
  }
  console.warn(
    `[Config] ${name} not set — using an insecure development fallback. Set it before deploying.`
  );
  return devFallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Refund policy, expressed as an ordered table instead of an if/else chain, so the
 * business rule lives in one auditable place and can be tuned per-market without
 * touching the engine. `withinMinutes: null` is the terminal (no-refund) tier.
 *
 * `penaltyPercent` is the share of the order the buyer forfeits. The buyer always
 * receives exactly `100 - penaltyPercent` percent — see refundEngine for how the
 * forfeited pool is split between seller and platform.
 */
export interface RefundTier {
  id: string;
  label: string;
  withinMinutes: number | null;
  penaltyPercent: number;
  allowed: boolean;
}

const DEFAULT_REFUND_TIERS: RefundTier[] = [
  { id: '0-10min', label: '0–10 daqiqa', withinMinutes: 10, penaltyPercent: 0, allowed: true },
  { id: '10min-2h', label: '10 daqiqa – 2 soat', withinMinutes: 120, penaltyPercent: 10, allowed: true },
  { id: '2h-24h', label: '2 – 24 soat', withinMinutes: 1440, penaltyPercent: 50, allowed: true },
  { id: 'over24h', label: '24 soatdan keyin', withinMinutes: null, penaltyPercent: 100, allowed: false },
];

function parseRefundTiers(): RefundTier[] {
  const raw = process.env.REFUND_TIERS;
  if (!raw) return DEFAULT_REFUND_TIERS;
  try {
    const parsed = JSON.parse(raw) as RefundTier[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty');
    return parsed;
  } catch (err) {
    console.warn('[Config] REFUND_TIERS is not valid JSON — falling back to defaults.');
    return DEFAULT_REFUND_TIERS;
  }
}

/** Bank cards buyers can pay into. Rotating these is an ops action, not a code change. */
export interface PaymentCard {
  id: string;
  number: string;
  holder: string;
  bank: string;
  active: boolean;
}

function parsePaymentCards(): PaymentCard[] {
  const raw = process.env.PAYMENT_CARDS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PaymentCard[];
    return Array.isArray(parsed) ? parsed.filter((c) => c.active !== false) : [];
  } catch {
    console.warn('[Config] PAYMENT_CARDS is not valid JSON — no cards configured.');
    return [];
  }
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd,
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/bitmax',
  port: parseInt(process.env.PORT || '3001', 10),
  botToken: process.env.BOT_TOKEN || '',
  botWebhookUrl: process.env.BOT_WEBHOOK_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/telegram/webhook` : ''),
  adminChatId: process.env.ADMIN_CHAT_ID || '',
  // Extra admins beyond the owner — comma separated telegram ids.
  extraAdminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  webhookSecret: required('WEBHOOK_SECRET', 'dev_only_webhook_secret_change_me'),
  // Shared secret required on every internal (non-public) backend route, e.g. escrow/transactions
  // management. Only the bot process and trusted internal tools should ever hold this value.
  internalApiKey: required('INTERNAL_API_KEY', 'dev_only_internal_key_change_me'),
  // 32-byte key (64 hex chars) used to envelope-encrypt account credentials at rest.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryptionKey: required(
    'ENCRYPTION_KEY',
    '0'.repeat(64) // dev-only: predictable, never use outside local development
  ),

  // Signs the web session token (see utils/jwt.ts). Separate from every other secret on
  // purpose: leaking it forges logins but decrypts nothing, and rotating it just logs
  // everybody out instead of destroying stored credentials.
  sessionSecret: required('SESSION_SECRET', 'dev_only_session_secret_change_me'),
  // How long a browser session stays valid before the user has to re-approve in the bot.
  webSessionDays: num('WEB_SESSION_DAYS', 7),
  // How long an unapproved web login request stays claimable.
  loginRequestMinutes: num('LOGIN_REQUEST_MINUTES', 5),

  platformCommission: num('PLATFORM_COMMISSION', 7),
  refundTiers: parseRefundTiers(),
  paymentCards: parsePaymentCards(),
  paymentProvider: process.env.PAYMENT_PROVIDER || 'sms',
  tezcheck: {
    apiKey: process.env.TEZCHECK_API_KEY || '',
    cashDeskCode: process.env.TEZCHECK_CASH_DESK_CODE || '',
    webhookSecret: process.env.TEZCHECK_WEBHOOK_SECRET || '',
    baseUrl: process.env.TEZCHECK_BASE_URL || 'https://api.tezcheck.uz/api/merchant/v1',
    providerCodes: (process.env.TEZCHECK_PROVIDER_CODES || 'click,payme').split(',').map(s => s.trim()).filter(Boolean),
  },

  // How long a buyer has to transfer the unique amount before the reservation lapses.
  paymentWindowMinutes: num('PAYMENT_WINDOW_MINUTES', 10),
  // After this long with no buyer action, escrow releases to the seller automatically.
  // The TZ requires this ("24 soatdan keyin pul sotuvchiga o'tadi") — the scheduler enforces it.
  autoReleaseHours: num('AUTO_RELEASE_HOURS', 24),
  // If the buyer never even opens the credentials, releasing to the seller would pay for a
  // delivery the buyer never took. After this long an unopened order is refunded in full and
  // the listing goes back on sale instead.
  unrevealedGraceHours: num('UNREVEALED_GRACE_HOURS', 72),
  // Minimum withdrawal, and the flat fee the platform passes on for a bank transfer.
  minPayoutAmount: num('MIN_PAYOUT_AMOUNT', 10000),
  payoutFeeFlat: num('PAYOUT_FEE_FLAT', 0),
  // A buyer who exceeds this many refunds in 30 days loses automatic refunds and is
  // routed to manual arbitration instead — the main defence against refund farming.
  refundAbuseThreshold: num('REFUND_ABUSE_THRESHOLD', 3),
  // Credentials are wiped from the database this many days after an order settles.
  credentialRetentionDays: num('CREDENTIAL_RETENTION_DAYS', 30),

  // ─── Images (Cloudinary) ───────────────────────────────────────────────────
  // Signed uploads — the bot backend signs every upload with the API secret, so only this
  // server can push images into the account (unlike an unsigned upload_preset, which anyone
  // who learns the preset name could use). Left blank in dev; the upload step just fails
  // closed with a clear error until these are set.
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  // Hard cap on how many photos a single product/deal can carry.
  maxProductImages: num('MAX_PRODUCT_IMAGES', 8),

  siteUrl: process.env.SITE_URL || 'https://web-three-eosin-46.vercel.app',
  botUsername: process.env.BOT_USERNAME || 'bitmax_bot',
  supportUsername: process.env.SUPPORT_USERNAME || 'bitmax_admin',

  // Comma-separated list of origins allowed to call the public API from a browser.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Optional comma-separated allowlist of SMS sender ids/names (e.g. bank shortcodes).
  // When empty, sender is not checked (backward compatible with current SMS forwarder setup).
  smsAllowedSenders: (process.env.SMS_ALLOWED_SENDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Background jobs run in this process by default. Set to false on extra replicas so
  // only one instance sweeps expiries / auto-releases.
  jobsEnabled: process.env.JOBS_ENABLED !== 'false',

  /**
   * Lets one account both sell and buy the same item, so a single Telegram account can walk
   * the whole flow end to end. Off by default and meant to stay off in normal operation: a
   * self-purchase costs the buyer only the 7% commission but still increments
   * `sellerStats.sold`, which is how trust levels — and with them the price ceiling — are
   * earned. Left on, it is a free path to "trusted" seller.
   */
  allowSelfPurchase: process.env.ALLOW_SELF_PURCHASE === 'true',
};

if (config.allowSelfPurchase) {
  console.warn(
    '[Config] ALLOW_SELF_PURCHASE=true — o‘z mahsulotini sotib olish YOQILGAN. ' +
      'Bu faqat sinov uchun; ishlab chiqarishda o‘chiring.'
  );
}

/** True for the platform owner and any additional configured admin telegram id. */
export function isAdminTelegramId(telegramId: number | string): boolean {
  const id = String(telegramId);
  return id === config.adminChatId || config.extraAdminIds.includes(id);
}

// Constant-time comparison so guessing the webhook/internal secret can't be sped up via
// response-time side channels.
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length buffers so the timing doesn't leak length either.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

if (!['sms', 'tezcheck'].includes(config.paymentProvider)) throw new Error('Invalid PAYMENT_PROVIDER');
if (config.paymentProvider === 'tezcheck' && (!config.tezcheck.apiKey || config.tezcheck.apiKey.includes('*') || !config.tezcheck.cashDeskCode || !config.tezcheck.webhookSecret)) {
  throw new Error('TezCheck requires full API key, cash desk code and webhook secret');
}
