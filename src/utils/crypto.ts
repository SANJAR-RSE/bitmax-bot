import crypto from 'crypto';
import { config } from '../config';

/**
 * Envelope encryption for account credentials (login / password / recovery codes).
 *
 * These are the single most valuable thing in the database: a dump of the products
 * collection in plaintext is a dump of every seller's live account. AES-256-GCM gives
 * confidentiality plus an authentication tag, so a tampered ciphertext fails to decrypt
 * rather than silently returning garbage that we'd hand to a buyer.
 *
 * Format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. The version prefix is what lets us
 * rotate to a new algorithm/key later without a big-bang migration.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = config.encryptionKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    // Accept a passphrase too, but stretch it — a raw utf8 passphrase would otherwise be
    // a low-entropy key. scrypt with a fixed salt is deterministic, which is what we need
    // since the same key must be derivable on every process start.
    // Keep the original salt stable so existing encrypted credentials remain readable.
    cachedKey = crypto.scryptSync(raw, 'bitimax:credential:v1', 32);
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a value produced by encryptSecret. Values that were written before encryption
 * existed are returned unchanged, so an existing database keeps working while a migration
 * backfills — see scripts/encryptExistingSecrets.ts.
 */
export function decryptSecret(payload: string): string {
  if (!payload) return '';
  if (!payload.startsWith(`${VERSION}:`)) return payload; // legacy plaintext

  const parts = payload.split(':');
  if (parts.length !== 4) return payload;

  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    // A failure here means the key changed or the record was tampered with. Never fall back
    // to returning the raw ciphertext as if it were the credential.
    console.error('[Crypto] Failed to decrypt secret — wrong ENCRYPTION_KEY or corrupted record.');
    throw new Error('Credential could not be decrypted');
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

/** Stable fingerprint used to deduplicate inbound SMS deliveries. */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token for one-time credential reveal links. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
