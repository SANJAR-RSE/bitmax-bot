import { config } from '../config';
import { checkHamyonOrder } from './hamyonPayments';
import { notificationService } from './notificationService';

const watching = new Map<string, NodeJS.Timeout>();

/**
 * Polls Hamyon for one order while its buyer waits in the bot.
 *
 * The backend's sweep and Hamyon's callback both depend on the backend being awake, and a free
 * Render instance sleeps. The bot is awake here because the buyer just used it, so it asks
 * Hamyon itself and delivers the "payment received" message with the reveal button at once.
 */
export function watchHamyonPayment(transactionId: string, expiresAt: Date, chatId: number, intervalMs = 8_000) {
  if (config.paymentProvider !== 'hamyon' || watching.has(transactionId)) return;
  const giveUpAt = expiresAt.getTime() + 3 * 60_000;
  let busy = false;

  const stop = () => {
    const timer = watching.get(transactionId);
    if (timer) clearInterval(timer);
    watching.delete(transactionId);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = await checkHamyonOrder(transactionId, intervalMs - 1_000);
      if (!t || t.status !== 'pending_payment') return stop();
      if (t.paymentReview) {
        stop();
        await notificationService.notifyBuyer(
          chatId,
          '⏳ To‘lovingiz qo‘lda tekshirilmoqda. Qayta pul o‘tkazmang — admin tez orada javob beradi.'
        );
        return;
      }
      if (Date.now() > giveUpAt) stop();
    } catch {
      console.error('[Hamyon] Watcher check failed:', transactionId);
      if (Date.now() > giveUpAt) stop();
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  watching.set(transactionId, timer);
}
