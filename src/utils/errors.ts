import { AlreadyProcessedError, ForbiddenError, PaymentProviderError, ProductUnavailableError } from '../services/paymentService';
import { ImageUploadError } from '../services/cloudinaryService';

/**
 * Maps the handful of error types the payment/escrow/upload flows actually throw to specific
 * Uzbek copy, falling back to a generic message only for truly unexpected errors. Before this,
 * `buy_(.+)`, `reveal_(.+)`, `confirm_escrow_(.+)` and `rdo_*` each caught everything with the
 * same "Xatolik yuz berdi, qayta urinib ko'ring" — a buyer whose product was just bought out
 * from under them saw the identical message as one hitting a genuine bug, with no way to tell
 * "try again" from "this can never work".
 */
export function describeError(error: unknown): string {
  if (error instanceof ProductUnavailableError) {
    return '❌ Bu mahsulot band qilingan yoki allaqachon sotilgan.';
  }
  if (error instanceof AlreadyProcessedError) {
    return 'ℹ️ Bu buyurtma allaqachon yopilgan — qayta ishlov berish shart emas.';
  }
  if (error instanceof ForbiddenError) {
    return `❌ ${(error as Error).message || 'Ruxsat yo‘q'}`;
  }
  if (error instanceof PaymentProviderError) {
    return `⚠️ ${error.message}`;
  }
  if (error instanceof ImageUploadError) {
    return `⚠️ ${error.message}`;
  }
  console.error('[Bot] Unhandled error:', error);
  return '⚠️ Kutilmagan xatolik yuz berdi. Birozdan keyin qayta urinib ko‘ring yoki qo‘llab-quvvatlashga yozing.';
}
