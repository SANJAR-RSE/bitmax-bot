import crypto from 'crypto';
import { config } from '../config';

export class ImageUploadError extends Error {
  constructor(message = 'Rasm yuklab bo‘lmadi') {
    super(message);
    this.name = 'ImageUploadError';
  }
}

/**
 * Signs a Cloudinary upload request server-side (rather than shipping an unsigned
 * `upload_preset` to the client) so only this backend — the one holding the API secret — can
 * push images into the account. Formula is Cloudinary's documented one: sort every param
 * alphabetically, join as `key=value&key=value`, append the API secret, SHA-1 it.
 * https://cloudinary.com/documentation/authentication_signatures
 */
function signParams(params: Record<string, string | number>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto
    .createHash('sha1')
    .update(toSign + config.cloudinaryApiSecret)
    .digest('hex');
}

/**
 * Downloads a Telegram-hosted photo and re-uploads it to Cloudinary, returning the public CDN
 * URL to store on the product. Telegram's file links are meant for short-lived bot use, not for
 * embedding in a website — Cloudinary is the durable, publicly-servable copy.
 *
 * Node 18+ ships `fetch`/`FormData`/`Blob` globally, so this needs no new dependency.
 */
export async function uploadTelegramPhoto(telegram: any, fileId: string): Promise<string> {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new ImageUploadError(
      'Rasm yuklash sozlanmagan — admin bilan bog‘laning (Cloudinary kalitlar yo‘q)'
    );
  }

  const fileLink = await telegram.getFileLink(fileId);
  const fileResponse = await fetch(fileLink.toString());
  if (!fileResponse.ok) {
    throw new ImageUploadError('Telegramdan rasmni olib bo‘lmadi, qayta urinib ko‘ring');
  }
  const bytes = await fileResponse.arrayBuffer();

  const timestamp = Math.floor(Date.now() / 1000);
  // Deal images sit in their own folder so they're easy to find/purge separately from anything
  // else the account might one day upload into the same Cloudinary account.
  const paramsToSign = { folder: 'bitmax/products', timestamp };
  const signature = signParams(paramsToSign);

  const form = new FormData();
  form.append('file', new Blob([bytes]), `${fileId}.jpg`);
  form.append('api_key', config.cloudinaryApiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', paramsToSign.folder);
  form.append('signature', signature);

  const uploadResponse = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
    { method: 'POST', body: form }
  );

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text().catch(() => '');
    console.error('[Cloudinary] Upload failed:', uploadResponse.status, body.slice(0, 300));
    throw new ImageUploadError('Rasm yuklanmadi, qayta urinib ko‘ring');
  }

  const data = (await uploadResponse.json()) as { secure_url?: string };
  if (!data.secure_url) throw new ImageUploadError('Rasm yuklanmadi, qayta urinib ko‘ring');
  return data.secure_url;
}

/**
 * Sniffs the real type of an uploaded file from its leading bytes.
 *
 * The browser's Content-Type is attacker-supplied and a file extension is decoration; the
 * only trustworthy statement about "is this actually an image" is the file's own header.
 * Anything not on this list never reaches Cloudinary.
 */
export function detectImageType(bytes: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return null;
}

/**
 * Uploads raw image bytes (a photo a seller picked in the browser) to the same signed
 * Cloudinary account the bot's photo step uses.
 *
 * Bytes are proxied through this server rather than handing the browser a signed upload
 * ticket: a ticket is a bearer credential that can be replayed against the account with any
 * payload, whereas here every byte that reaches Cloudinary has been type-checked and
 * size-capped by code we control.
 */
export async function uploadImageBuffer(bytes: Buffer, folder = 'bitmax/products'): Promise<string> {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new ImageUploadError('Rasm yuklash sozlanmagan — admin bilan bog‘laning');
  }

  const kind = detectImageType(bytes);
  if (!kind) throw new ImageUploadError('Faqat JPG, PNG yoki WEBP rasm yuklash mumkin');

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { folder, timestamp };
  const signature = signParams(paramsToSign);

  const form = new FormData();
  form.append('file', new Blob([bytes]), `upload.${kind}`);
  form.append('api_key', config.cloudinaryApiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
    { method: 'POST', body: form }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[Cloudinary] Buffer upload failed:', response.status, body.slice(0, 300));
    throw new ImageUploadError('Rasm yuklanmadi, qayta urinib ko‘ring');
  }

  const data = (await response.json()) as { secure_url?: string };
  if (!data.secure_url) throw new ImageUploadError('Rasm yuklanmadi, qayta urinib ko‘ring');
  return data.secure_url;
}
