import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../config';

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const billSchema = z.object({
  id: z.string().min(1), external_reference: z.string(), amount_minor: minor,
  currency: z.literal('UZS'), state: z.string(),
  paid: z.boolean(), environment: z.string().nullable().optional(), livemode: z.boolean(),
});
export const paymentSchema = z.object({
  id: z.string().min(1), state: z.string(), amount_minor: minor,
  fee_minor: minor, net_minor: minor, refunded_amount_minor: minor,
  currency: z.literal('UZS'), environment: z.string(), livemode: z.boolean(),
  problem: z.object({ unknown_reason: z.string().nullable().optional() }).passthrough().nullable().optional(),
});
export const statusSchema = z.object({ bill: billSchema, payment: paymentSchema.nullable() });
export type BillStatus = z.infer<typeof statusSchema>;
export interface BillRequest {
  amount_minor: number; title: string; external_reference: string;
  allowed_provider_codes: string[];
}
export function toMinor(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100)) {
    throw new Error('Invalid payment amount');
  }
  return amount * 100;
}
export function requestSignature(key: string, timestamp: string, method: string, path: string, body: string) {
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  return 'v1=' + crypto.createHmac('sha256', key).update(`${timestamp}.${method}.${path}.${digest}`).digest('hex');
}
export function verifyWebhook(raw: Buffer, timestamp: string, delivery: string, signature: string, secret: string, now = Date.now()) {
  if (!secret || !/^\d+$/.test(timestamp) || !delivery || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${delivery}.`).update(raw).digest();
  return signature.split(',').some(value => {
    const match = /^v1=([a-fA-F0-9]{64})$/.exec(value.trim());
    return Boolean(match && crypto.timingSafeEqual(expected, Buffer.from(match[1], 'hex')));
  });
}
export function isLivePaid(data: BillStatus, expected: { id: string; reference: string; amountMinor: number }): boolean {
  const { bill, payment } = data;
  if (bill.id !== expected.id || bill.external_reference !== expected.reference || bill.amount_minor !== expected.amountMinor) {
    throw new Error('TezCheck bill does not match order');
  }
  if (!bill.paid || !payment || payment.state !== 'succeeded' || payment.problem) return false;
  if (bill.environment !== 'live' || !bill.livemode || payment.environment !== 'live' || !payment.livemode) return false;
  if (payment.amount_minor !== expected.amountMinor || payment.refunded_amount_minor !== 0 ||
      payment.fee_minor + payment.net_minor !== payment.amount_minor) throw new Error('TezCheck payment amount mismatch');
  return true;
}
export class TezcheckClient {
  private signedAt = new Map<string, number>();
  constructor(private options = config.tezcheck) {}
  async request(method: 'GET' | 'POST', path: string, body = '', idempotencyKey?: string): Promise<any> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, '') + path);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('TezCheck requires HTTPS');
    }
    // A repeated request in the same second would reuse the one-time signature.
    const identity = crypto.createHash('sha256').update(`${method}:${url.pathname}${url.search}:${body}`).digest('hex');
    let second = Math.floor(Date.now() / 1000);
    while (this.signedAt.get(identity) === second) {
      await new Promise(resolve => setTimeout(resolve, 1010 - Date.now() % 1000));
      second = Math.floor(Date.now() / 1000);
    }
    for (const [key, time] of this.signedAt) if (time < second) this.signedAt.delete(key);
    this.signedAt.set(identity, second);
    const timestamp = String(second);
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'X-Cash-Desk-Code': this.options.cashDeskCode,
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-TezCheck-Timestamp': timestamp,
        'X-TezCheck-Signature': requestSignature(this.options.apiKey, timestamp, method, url.pathname + url.search, body),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(method === 'POST' ? { body } : {}),
    });
    if (!response.ok) throw new Error(`TezCheck HTTP ${response.status}`);
    const json = await response.json() as any;
    if (!json || !('data' in json)) throw new Error('Invalid TezCheck response');
    return json.data;
  }
  me() { return this.request('GET', '/me'); }
  async createBill(body: string, key: string) {
    const data = await this.request('POST', '/bills', body, key);
    return z.object({ bill: z.object({ id: z.string().min(1), external_reference: z.string(), amount_minor: minor, currency: z.literal('UZS') }),
      payment_url: z.string().url().refine(value => new URL(value).protocol === 'https:') }).parse(data);
  }
  async getBill(id: string) { return statusSchema.parse(await this.request('POST', `/bills/${encodeURIComponent(id)}`)); }
  async cancelBill(id: string) {
    return this.request('POST', `/bills/${encodeURIComponent(id)}/cancel`, JSON.stringify({ reason: 'Order payment window expired' }), `cancel-${id}`);
  }
}
export const tezcheckClient = new TezcheckClient();
