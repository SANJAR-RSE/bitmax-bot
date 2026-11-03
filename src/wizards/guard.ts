import { mainMenuKeyboard } from '../keyboards';

/**
 * Matches the same "leave the wizard" input `CODE_WIZARD` already recognized (buyer.ts) —
 * the reply-keyboard "🏠 Asosiy menu" button, or typing "bekor"/"/cancel".
 */
const CANCEL_PATTERN = /^(?:🏠(?: Asosiy menu)?|Asosiy menu|bekor|\/cancel)$/i;

/**
 * A `Scenes.WizardScene` step swallows every update while it's active — including presses of
 * the "🏠 Asosiy menu" reply-keyboard button shown alongside most wizards. Without an explicit
 * check, that button press was silently accepted as literal step input (a title, a login, a
 * password) instead of exiting, and the button stayed on screen looking clickable for the rest
 * of the wizard.
 *
 * Call this as the very first line of every wizard step that reads `ctx.message`. When it
 * returns `true` the step has already replied and left the scene — the caller must `return`
 * immediately without doing anything else.
 */
export async function bailIfCancelled(ctx: any, sessionKeys: string[] = []): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  if (!text || !CANCEL_PATTERN.test(text)) return false;

  for (const key of sessionKeys) {
    if (ctx.session) ctx.session[key] = undefined;
  }
  await ctx.reply('Bekor qilindi.', mainMenuKeyboard);
  await ctx.scene.leave();
  return true;
}
