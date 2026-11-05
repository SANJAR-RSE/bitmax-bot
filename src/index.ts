import crypto from 'crypto';
import express, { RequestHandler } from 'express';
import helmet from 'helmet';
import { Telegraf, Scenes, session } from 'telegraf';
import { config, isAdminTelegramId } from './config';
import { connectDatabase } from './db/mongoose';
import { mongoSessionStore } from './models/BotSession';
import { User } from './models/User';
import { notificationService } from './services/notificationService';
import { CATEGORIES } from './categories';
import { startHandler, createPayoutWizards, keyboardFor } from './handlers/start';
import { sellerHandler, createSellerWizard, createDealWizard } from './handlers/seller';
import { buyerHandler, createCodeWizard } from './handlers/buyer';
import { adminHandler, createRoleWizard } from './handlers/admin';
import { botApi } from './services/botApi';
import { listingLookup } from './handlers/catalog';
import { wizardEscape } from './wizards/escape';
import { escapeHtml, formatUzs } from './utils/helpers';

/**
 * Starts the Telegraf bot (long-polling). Assumes the caller has already connected to
 * the database — this lets it run either standalone (see the bottom of this file) or
 * embedded in the same process as the HTTP API (see src/index.ts), sharing one Mongo
 * connection instead of opening two.
 */
let webhookHandler: RequestHandler | undefined;
export const telegramWebhook: RequestHandler = (req, res, next) => {
  if (!webhookHandler) { res.status(503).json({ error: 'Bot starting' }); return; }
  return webhookHandler(req, res, next);
};

export async function startBot(): Promise<void> {
  if (!config.botToken || config.botToken === 'YOUR_BOT_TOKEN_HERE') {
    // In production the bot *is* the product: refuse to boot half a platform. Locally, a
    // missing token is the normal case while working on the website, so the API and the
    // scheduler are allowed to run without it instead of taking the whole process down.
    if (config.isProd) {
      throw new Error('[Bot] BOT_TOKEN is not configured! Please set BOT_TOKEN in .env file');
    }
    console.warn(
      '[Bot] BOT_TOKEN not set — bot disabled. The API and the scheduler keep running; ' +
        'Telegram notifications are skipped.'
    );
    return;
  }

  const bot = new Telegraf<any>(config.botToken);
  notificationService.setBot(bot);

  const stage = new Scenes.Stage<any>([
    createSellerWizard(),
    createDealWizard(),
    createCodeWizard(),
    createRoleWizard(),
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

  if (config.botWebhookUrl) {
    const secret = crypto.createHmac('sha256', config.internalApiKey).update('telegram-webhook-v1').digest('hex');
    bot.botInfo = await bot.telegram.getMe();
    webhookHandler = bot.webhookCallback('/api/telegram/webhook', { secretToken: secret });
    await bot.telegram.setWebhook(config.botWebhookUrl, { secret_token: secret, max_connections: 1 });
    console.log('[Bot] Telegram webhook ready');
    return;
  }

  // In long-polling mode bot.launch() only resolves once the bot is stopped (its internal
  // loop runs until then), so awaiting it here would hang startBot() forever and, when
  // embedded in the HTTP server process, block start() from ever finishing. It is launched
  // in the background and supervised instead.
  launchWithRetry(bot);

  process.once('SIGINT', () => {
    stopping = true;
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stopping = true;
    bot.stop('SIGTERM');
  });
}

let stopping = false;

/**
 * Keeps the bot polling across transient Telegram failures.
 *
 * The one that matters is 409 Conflict. Render (like most platforms) does a zero-downtime
 * rollout: the new instance boots while the old one is still draining, so for a few seconds
 * two processes poll the same token and Telegram rejects one of them. Telegraf treats that as
 * fatal and stops the polling loop for good — which meant every single deploy left the bot
 * silently dead until someone noticed and restarted it by hand.
 *
 * Retrying with backoff rides out the overlap: the loser waits, the old instance finishes
 * shutting down, and the next attempt succeeds.
 */
async function launchWithRetry(bot: Telegraf<any>): Promise<void> {
  const MAX_ATTEMPTS = 20;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !stopping; attempt++) {
    try {
      if (attempt === 1) console.log('[Bot] Bitmax bot starting (long polling)…');
      // Resolves only once the bot is stopped, so reaching the next line means a clean stop.
      await bot.launch({ dropPendingUpdates: true });
      console.log('[Bot] Polling loop ended cleanly');
      return;
    } catch (err: any) {
      if (stopping) return;

      const code = err?.response?.error_code ?? err?.code;
      const isConflict = code === 409;

      if (!isConflict && attempt >= 5) {
        console.error('[Bot] Giving up after repeated non-conflict failures:', err?.message || err);
        return;
      }

      // Cap the wait at 30s: a deploy overlap clears in well under a minute, and a longer
      // backoff would just extend the window where the bot answers nobody.
      //
      // The jitter is what actually breaks the deadlock. Both instances run this same loop,
      // so a purely deterministic backoff has them wake in lockstep and collide again and
      // again — observed in production as four straight rounds of mutual 409s. Randomising
      // the wait means one of them reaches Telegram alone on the next attempt.
      const base = Math.min(30_000, 3_000 * 2 ** Math.min(attempt - 1, 4));
      const waitMs = Math.round(base * (0.5 + Math.random()));
      console.warn(
        `[Bot] Polling failed (${isConflict ? '409 conflict — another instance is still polling' : code || 'unknown'}). ` +
          `Retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(waitMs / 1000)}s`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  if (!stopping) {
    console.error('[Bot] Could not start polling after all retries — bot is NOT running');
  }
}

// Bitmax bot now runs as its own deployed service, separate from the HTTP API. Render
// (and most platforms) still expect a bound port for health checks, so this exposes just
// enough HTTP surface for that plus the Telegram webhook — long polling needs neither.
if (require.main === module) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  app.get(['/health', '/healt'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', service: 'bitmax-bot', version: '1.0.0' });
  });

  app.post('/api/telegram/webhook', (req, res, next) => telegramWebhook(req, res, next));

  // Bound first: the platform's port check must not depend on Mongo or Telegram being quick.
  // Webhook deliveries that arrive before the bot is ready get a 503 and Telegram retries them.
  app.listen(config.port, () => {
    console.log(`[Bot] HTTP surface (health + webhook) listening on port ${config.port}`);
  });

  connectDatabase()
    .then(startBot)
    .catch((err) => {
      console.error('[Bot] Fatal startup error:', err);
      process.exit(1);
    });
}
