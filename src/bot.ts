import { Telegraf, Scenes, session } from 'telegraf';
import { isAdminTelegramId } from './config';
import { mongoSessionStore } from './models/BotSession';
import { User } from './models/User';
import { notificationService } from './services/notificationService';
import { CATEGORIES } from './categories';
import { startHandler, createPayoutWizards, keyboardFor } from './handlers/start';
import { sellerHandler, createSellerWizard, createDealWizard } from './handlers/seller';
import { buyerHandler, createCodeWizard } from './handlers/buyer';
import { adminHandler, createRoleWizard } from './handlers/admin';
import { createEvidenceScene, evidenceHandler } from './handlers/evidence';
import { botApi } from './services/botApi';
import { listingLookup } from './handlers/catalog';
import { wizardEscape } from './wizards/escape';
import { escapeHtml, formatUzs } from './utils/helpers';

/**
 * Builds the fully wired bot without connecting it to Telegram, so the bot the service runs is
 * the same one tests drive with a fake Telegram API (src/integration).
 */
export function createBot(token: string): Telegraf<any> {
  const bot = new Telegraf<any>(token);
  notificationService.setBot(bot);

  const stage = new Scenes.Stage<any>([
    createSellerWizard(),
    createDealWizard(),
    createCodeWizard(),
    createRoleWizard(),
    createEvidenceScene(),
    ...createPayoutWizards(),
  ]);

  // Persisted in Mongo rather than Telegraf's default in-memory Map, so a deploy no longer
  // wipes every half-finished listing wizard and multiple replicas can share state.
  bot.command(['healt', 'health'], async (ctx) => {
    await ctx.reply('Bitmax bot ishlayapti.');
  });

  bot.use(session({ store: mongoSessionStore }));

  /**
   * Registers the user and stops blocked accounts at the door. `isBlocked` existed in v1 but
   * was never read anywhere — blocking a scammer flipped a boolean and changed nothing.
   */
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    try {
      const user = await botApi.getOrCreateUser(ctx.from.id, ctx);
      if (user.isBlocked) {
        const notice = `❌ Hisobingiz bloklangan.\n${user.blockReason || ''}\n\n${botApi.supportLink()}`;
        if (ctx.callbackQuery) await ctx.answerCbQuery('Hisobingiz bloklangan');
        else await ctx.reply(notice);
        return;
      }
      // Done here, before any handler runs, so the first /start already shows the admin menu.
      if (isAdminTelegramId(ctx.from.id) && user.role !== 'admin') {
        await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
        user.role = 'admin';
      }
      (ctx.state as any).user = user;
    } catch (err) {
      console.error('[Bot] Failed to resolve user:', err);
      await ctx.reply('Hisobni yuklab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.');
      return;
    }

    return next();
  });

  bot.use(wizardEscape);
  bot.use(listingLookup);
  bot.use(stage.middleware());

  bot.use(evidenceHandler);
  bot.use(startHandler);
  bot.use(sellerHandler);
  bot.use(buyerHandler);
  bot.use(adminHandler);

  bot.action('settings_notifications', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from!.id });
    if (!user) return void ctx.answerCbQuery('Topilmadi');

    user.notificationSettings.newOrder = !user.notificationSettings.newOrder;
    await user.save();

    await ctx.answerCbQuery(user.notificationSettings.newOrder ? 'Yoqildi' : 'O‘chirildi');
    await ctx.replyWithHTML(
      `✅ Bildirishnomalar yangilandi:\n` +
        `• Yangi buyurtma: ${user.notificationSettings.newOrder ? '✅' : '❌'}\n` +
        `• To‘lov: ${user.notificationSettings.paymentConfirm ? '✅' : '❌'}\n` +
        `• Qaytarish: ${user.notificationSettings.refundUpdate ? '✅' : '❌'}`
    );
  });

  bot.action('back_main', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from!.id });
    await ctx.reply('Asosiy menu', keyboardFor(user?.role || 'buyer'));
    await ctx.answerCbQuery();
  });

  bot.command('categories', async (ctx) => {
    await ctx.replyWithHTML('<b>📂 Kategoriyalar</b>', {
      reply_markup: {
        inline_keyboard: CATEGORIES.map((c) => [{ text: c, callback_data: `cat_${c}` }]),
      },
    });
  });

  bot.action(/^cat_(.+)$/, async (ctx) => {
    const category = ctx.match[1];
    const { products, total } = await botApi.getActiveProducts(1, 10, category);

    if (products.length === 0) {
      await ctx.editMessageText(`📂 <b>${escapeHtml(category)}</b> — mahsulot topilmadi`, {
        parse_mode: 'HTML',
      });
      await ctx.answerCbQuery();
      return;
    }

    const lines = products.map(
      (p) => `• <b>${escapeHtml(p.title)}</b> — ${formatUzs(p.price)}\n  /p_${p._id}`
    );

    await ctx.editMessageText(
      [`<b>📂 ${escapeHtml(category)}</b> (${total} ta)`, '', ...lines].join('\n'),
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
  });

  /** `/p_<id>` opens a listing — the link format the category browser emits. */
  bot.hears(/^\/p_([0-9a-fA-F]{24})$/, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.replyWithHTML('Mahsulotni ochish:', {
      reply_markup: {
        inline_keyboard: [[{ text: '🔍 Batafsil', callback_data: `detail_${productId}` }]],
      },
    });
  });

  // Anything no handler claimed gets an answer: silence reads as a dead bot.
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply('Buyruq tushunilmadi. Pastdagi menyudan tanlang yoki /help ni bosing.', keyboardFor((ctx.state as any).user?.role || 'buyer'));
  });

  bot.catch(async (err: any, ctx: any) => {
    console.error(`[Bot] Error handling ${ctx?.updateType}:`, err);
    const detail = String(err?.description || err?.message || '');
    if (/message is not modified|query is too old/i.test(detail)) return;
    if (ctx?.callbackQuery) await ctx.answerCbQuery().catch(() => undefined);
    await ctx?.reply?.('⚠️ Kutilmagan xatolik yuz berdi. Birozdan keyin qayta urinib ko‘ring.').catch(() => undefined);
  });

  return bot;
}
