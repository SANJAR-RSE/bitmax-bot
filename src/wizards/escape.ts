/** Main-menu labels. Pressing one mid-form means "take me there", not "use this as my input". */
const MENU_LABELS = new Set([
  'Akkaunt sotib olish',
  'Akkaunt sotish',
  'Kafil bitim',
  'Buyurtmalarim',
  'E’lonlarim',
  'Balans',
  'Sozlamalar',
  'Yordam',
  'Admin panel',
]);

const DRAFT_KEYS = ['productData', 'dealData', 'cardNumber', 'codeTries'];
const START_COMMAND = /^\/start(?:@\w+)?(?:\s|$)/i;
/** Buttons a form renders for itself. Every other button belongs to a screen outside it. */
const FORM_CALLBACK = /^(?:photos_(?:done|skip)|seller_publish_(?:confirm|cancel)|deal_publish_(?:confirm|cancel)|role_.+)$/;

/**
 * Runs before the scene stage, because an active wizard swallows every update. Without this, a
 * website login link opened mid-form was stored as the listing title and the login never ran.
 */
export async function wizardEscape(ctx: any, next: () => Promise<void>) {
  if (!ctx.session?.__scenes?.current) return next();

  const text = ctx.message?.text?.trim();
  if (text && (START_COMMAND.test(text) || MENU_LABELS.has(text))) {
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
