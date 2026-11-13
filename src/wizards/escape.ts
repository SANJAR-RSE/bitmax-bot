/**
 * Every reply-keyboard label a handler answers to (main menu, admin menu, and the older emoji
 * labels that Telegram keeps showing on clients that never received the new keyboard). Pressing
 * one mid-form means "take me there", not "use this as my input". The list used to hold only
 * the nine current main-menu labels, so "💰 Balans" from an old keyboard, or any admin-menu
 * button, was swallowed as a listing title or description.
 */
const MENU_LABELS = new Set([
  'Akkaunt sotib olish', 'Mahsulotlar', 'Kod bilan sotib olish',
  'Akkaunt sotish', 'Yangi e’lon',
  'Kafil bitim', 'Kafil bitim (escrow)',
  'Buyurtmalarim', 'Mening buyurtmalarim',
  'E’lonlarim', 'Mening e’lonlarim',
  'Balans', 'Sozlamalar', 'Yordam', 'Statistika', 'Asosiy menu',
  'Admin panel', 'Foydalanuvchilar', 'Moderatsiya', 'To‘lov so‘rovlari', 'To‘lov inbox', 'Nizolar',
]);

/** "💰 Balans" → "Balans": the emoji prefix is decoration, the label is what matters. */
function menuLabel(text: string): string {
  return text.replace(/^[^\p{L}\p{N}/]+/u, '').trim();
}

const DRAFT_KEYS = ['productData', 'dealData', 'cardNumber', 'codeTries'];
const START_COMMAND = /^\/start(?:@\w+)?(?:\s|$)/i;
/** Buttons a form renders for itself. Every other button belongs to a screen outside it. */
const FORM_CALLBACK = /^(?:photos_(?:done|skip)|seller_publish_(?:confirm|cancel)|deal_publish_(?:confirm|cancel)|role_.+|dsp_ev_done)$/;

/**
 * Runs before the scene stage, because an active wizard swallows every update. Without this, a
 * website login link opened mid-form was stored as the listing title and the login never ran.
 */
export async function wizardEscape(ctx: any, next: () => Promise<void>) {
  if (!ctx.session?.__scenes?.current) return next();

  const text = ctx.message?.text?.trim();
  if (text && (START_COMMAND.test(text) || MENU_LABELS.has(menuLabel(text)))) {
    delete ctx.session.__scenes;
    for (const key of DRAFT_KEYS) delete ctx.session[key];
    return next();
  }

  const data = ctx.callbackQuery?.data;
  if (data && !FORM_CALLBACK.test(data)) {
    await ctx.answerCbQuery('Avval formani yakunlang yoki /cancel yozing');
    return;
  }

  return next();
}
