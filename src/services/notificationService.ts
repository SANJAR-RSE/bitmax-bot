import { config } from '../config';
import { RefundQuote } from '../types';
import { escapeHtml, formatUzs, formatDeadline } from '../utils/helpers';

/** Plain inline-keyboard data for the admin refund alert — same shape Telegraf's
 * `Markup.inlineKeyboard` would produce, built by hand so this module stays free of a
 * Telegraf dependency (the bot package renders it; this one only describes it). */
function adminRefundButtons(escrowId: string, sellerId: string, productId: string) {
  return [
    [{ text: 'E’lonni o‘chirish', callback_data: `adm_delprod_${productId}` }],
    [{ text: 'Sotuvchini bloklash', callback_data: `adm_ban_${sellerId}` }],
    [{ text: 'Batafsil', callback_data: `adm_details_${escrowId}` }],
  ];
}

/** Inline support mention reused by the messages below — keeps the phrasing consistent. */
function botSupportLine(): string {
  return `qo‘llab-quvvatlashga yozing: https://t.me/${config.supportUsername}`;
}

type NotifyType = 'buyer' | 'seller' | 'admin';

interface NotifyPayload {
  type: NotifyType;
  chatId: number | string | undefined | null;
  message: string;
  buttons?: any[];
  /** Silences the delivery for low-priority updates. */
  silent?: boolean;
}

class NotificationService {
  private bot: any = null;

  setBot(botInstance: any) {
    this.bot = botInstance;
  }

  async send(payload: NotifyPayload): Promise<boolean> {
    if (!this.bot) {
      console.warn('[Notify] Bot not initialized, message skipped:', payload.message.slice(0, 60));
      return false;
    }
    if (!payload.chatId) return false;

    try {
      await this.bot.telegram.sendMessage(String(payload.chatId), payload.message, {
        parse_mode: 'HTML',
        disable_notification: payload.silent,
        ...(payload.buttons?.length ? { reply_markup: { inline_keyboard: payload.buttons } } : {}),
      });
      return true;
    } catch (error: any) {
      // 403 means the user blocked the bot — expected, not an incident worth a stack trace.
      const code = error?.response?.error_code;
      if (code === 403) {
        console.warn(`[Notify] ${payload.chatId} has blocked the bot`);
      } else {
        console.error(`[Notify] Failed to send to ${payload.chatId}:`, error?.message || error);
      }
      return false;
    }
  }

  async notifyAdmin(message: string, buttons?: any[]) {
    return this.send({
      type: 'admin',
      chatId: config.adminChatId,
      message: `🤖 <b>Bitmax Admin</b>\n\n${message}`,
      buttons,
    });
  }

  async notifyBuyer(chatId: number | string | undefined | null, message: string, buttons?: any[]) {
    return this.send({ type: 'buyer', chatId, message, buttons });
  }

  async notifySeller(chatId: number | string | undefined | null, message: string, buttons?: any[]) {
    return this.send({ type: 'seller', chatId, message, buttons });
  }

  /**
   * Tells the buyer their transfer landed, with the button that opens the credentials.
   *
   * `openDeadline` is the *first* of the two clocks (`unrevealedGraceHours`, from purchase) —
   * surfaced here, proactively, because previously it was never mentioned to the buyer at all;
   * they only learned about it after the fact, via the scheduler's auto-refund notice. The
   * *second* clock (`autoReleaseHours`, from reveal) only starts once they open the
   * credentials, so it's explained separately at that point (see buyer.ts's reveal screen) —
   * conflating the two in one message is exactly the confusion this is meant to remove.
   */
  async notifyPaymentConfirmed(
    chatId: number | string | undefined | null,
    productTitle: string,
    amount: number,
    escrowId: string,
    openDeadline: Date
  ) {
    return this.send({
      type: 'buyer',
      chatId,
      message: [
        `✅ <b>To‘lov qabul qilindi!</b>`,
        '',
        `<b>Mahsulot:</b> ${escapeHtml(productTitle)}`,
        `<b>Summa:</b> ${formatUzs(amount)}`,
        '',
        `Pul <b>escrow</b>da (kafilda) saqlanmoqda. Akkaunt ma’lumotlarini ochish uchun ` +
          `pastdagi tugmani bosing.`,
        '',
        `⚠️ <b>${formatDeadline(openDeadline)} gacha oching</b> — aks holda pul avtomatik ` +
          `balansingizga qaytariladi.`,
        `<i>Ma’lumotni ochgach, qaytarish uchun boshqa (qisqaroq) muddat boshlanadi — bu haqda ` +
          `o‘sha ekranda aytiladi.</i>`,
      ].join('\n'),
      buttons: [[{ text: '🔑 Ma’lumotlarni ochish', callback_data: `reveal_${escrowId}` }]],
    });
  }

  /**
   * Seller-facing counterpart to the deal-code expiry sweep. Before this existed, a code
   * expiring was completely silent — the seller only found out when the buyer said "your code
   * doesn't work" or they happened to reopen "📋 E’lonlarim" and noticed the line was gone.
   */
  async notifyDealExpired(
    chatId: number | string | undefined | null,
    dealTitle: string,
    dealCode: string
  ) {
    return this.send({
      type: 'seller',
      chatId,
      message: [
        `⏳ <b>Bitim kodi muddati tugadi</b>`,
        '',
        `<b>${escapeHtml(dealTitle)}</b>`,
        `Kod <code>${escapeHtml(dealCode)}</code> hech kim tomonidan ishlatilmadi va endi amal qilmaydi.`,
        '',
        `<i>Xaridor hali ham qiziqsa, “🤝 Kafil bitim” dan yangi kod yaratib bering.</i>`,
      ].join('\n'),
    });
  }

  /**
   * Buyer-facing counterpart to the payment-window expiry sweep. Before this existed, a missed
   * 10-minute window was a completely silent failure — the buyer had no way to learn the
   * reservation lapsed short of reopening the listing and noticing it was gone.
   */
  async notifyPaymentWindowExpired(
    chatId: number | string | undefined | null,
    productTitle: string,
    productId: string
  ) {
    return this.send({
      type: 'buyer',
      chatId,
      message: [
        `⏳ <b>To‘lov muddati tugadi</b>`,
        '',
        `<b>${escapeHtml(productTitle)}</b> uchun ajratilgan vaqt ichida to‘lov tushmadi, ` +
          `shuning uchun band qilish bekor qilindi.`,
        '',
        `<i>Pulingiz hech qaerga o‘tkazilmagan — agar allaqachon o‘tkazgan bo‘lsangiz, ` +
          `${botSupportLine()}.</i>`,
        '',
        `Hali ham qiziqsangiz, mahsulotni qaytadan oching va sotib olishni qayta boshlang.`,
      ].join('\n'),
      buttons: [[{ text: '🔍 Mahsulotni ko‘rish', callback_data: `detail_${productId}` }]],
    });
  }

  /**
   * Sent when a bank SMS arrived but matched no pending order (`no_match`). Previously the
   * buyer heard nothing at all — only the admin, and only after a 15-minute delay — which is
   * the single scariest gap in the flow from a buyer's side ("I paid, nothing happened, did my
   * money disappear?"). This message deliberately promises nothing ("we're checking", not
   * "confirmed") since the SMS is not provably this buyer's payment.
   */
  async notifyPossiblePaymentReceived(chatId: number | string | undefined | null) {
    return this.send({
      type: 'buyer',
      chatId,
      message: [
        `👀 <b>To‘lov haqida signal oldik</b>`,
        '',
        `Bankdan tushum haqida xabar keldi, lekin uni hali sizning buyurtmangizga aniq bog‘lay ` +
          `olmadik — tekshirilmoqda.`,
        '',
        `<i>Agar haqiqatan ham siz to‘lagan bo‘lsangiz, natija odatda bir necha daqiqada ` +
          `ko‘rinadi. Ko‘rinmasa — ${botSupportLine()}.</i>`,
      ].join('\n'),
      silent: true,
    });
  }

  async notifyRefundToAdmin(input: {
    buyer: string;
    seller: string;
    productTitle: string;
    amount: number;
    reason: string;
    quote: RefundQuote;
    escrowId: string;
    sellerId: string;
    productId: string;
  }) {
    const message = [
      `🔄 <b>Qaytarish amalga oshirildi</b>`,
      '',
      `<b>Xaridor:</b> ${escapeHtml(input.buyer)}`,
      `<b>Sotuvchi:</b> ${escapeHtml(input.seller)}`,
      `<b>Mahsulot:</b> ${escapeHtml(input.productTitle)}`,
      `<b>Summa:</b> ${formatUzs(input.amount)}`,
      `<b>Sabab:</b> ${escapeHtml(input.reason)}`,
      '',
      `<b>Davr:</b> ${input.quote.label} (${input.quote.elapsedMinutes} daq.)`,
      `<b>Jarima:</b> ${input.quote.penaltyPercent}%`,
      `<b>Xaridorga:</b> ${formatUzs(input.quote.refundToBuyer)}`,
      `<b>Sotuvchiga:</b> ${formatUzs(input.quote.sellerKeeps)}`,
      `<b>Platformaga:</b> ${formatUzs(input.quote.platformKeeps)}`,
      '',
      `<i>Akkauntni tekshiring va kerakli chorani ko‘ring.</i>`,
    ].join('\n');

    return this.notifyAdmin(
      message,
      adminRefundButtons(input.escrowId, input.sellerId, input.productId)
    );
  }
}

export const notificationService = new NotificationService();
