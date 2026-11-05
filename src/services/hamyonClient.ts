import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../config';

export class HamyonError extends Error {
  constructor(message = 'Hamyon request failed') {
    super(message);
    this.name = 'HamyonError';
  }
}

/** The shop already has an open payment for this exact amount, so another amount must be used. */
export class HamyonDuplicateAmountError extends HamyonError {
  constructor() {
    super('Hamyon already has an open payment for this amount');
    this.name = 'HamyonDuplicateAmountError';
  }
}

const createdSchema = z.object({
  payment_id: z.string().min(1),
  amount: z.coerce.number().int().positive(),
  card: z.string().min(1),
  expire_at: z.coerce.number().int().positive(),
});

const statusSchema = z.object({
  payment_id: z.string().min(1),
  shop_id: z.union([z.string(), z.number()]).optional(),
  amount: z.coerce.number().int().positive(),
  status: z.enum(['pending', 'paid', 'cancel']),
});

export type HamyonStatus = z.infer<typeof statusSchema>;

export function hamyonSign(shopId: string, paymentId: string, amount: string, shopKey: string): string {
  return crypto.createHash('md5').update(`${shopId}${paymentId}${amount}${shopKey}`).digest('hex');
}

/**
 * Proves a callback came from someone holding the shop key. `status` is not covered by this
 * signature, so a valid one never settles an order: the caller must confirm through getStatus().
 */
export function verifyHamyonSign(
  input: { shopId: string; paymentId: string; amount: string; sign: string },
  shopKey: string
): boolean {
  if (!shopKey) return false;
  const expected = Buffer.from(hamyonSign(input.shopId, input.paymentId, input.amount, shopKey));
  const actual = Buffer.from(input.sign.toLowerCase());
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${config.hamyon.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...(init.headers || {}) },
  });
  const data: any = await response.json().catch(() => null);
  if (response.ok && data) return data;
  const message = typeof data?.error === 'string' ? data.error : '';
  if (/ochiq/i.test(message)) throw new HamyonDuplicateAmountError();
  throw new HamyonError(`Hamyon HTTP ${response.status}${message ? `: ${message}` : ''}`);
}

export const hamyonClient = {
  async createPayment(amount: number, orderId: string) {
    const data = createdSchema.parse(
      await request('/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          shop_id: config.hamyon.shopId,
          shop_key: config.hamyon.shopKey,
          amount: String(amount),
          order_id: orderId,
        }).toString(),
      })
    );
    // The buyer is told to send exactly this amount, and matching depends on it.
    if (data.amount !== amount) throw new HamyonError('Hamyon returned a different amount');
    return { paymentId: data.payment_id, card: data.card.replace(/\D/g, ''), expireAt: new Date(data.expire_at * 1000) };
  },

  async getStatus(paymentId: string): Promise<HamyonStatus> {
    return statusSchema.parse(await request(`/payment/status?payment_id=${encodeURIComponent(paymentId)}`));
  },
};
