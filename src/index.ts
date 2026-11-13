import crypto from 'crypto';
import express, { RequestHandler } from 'express';
import helmet from 'helmet';
import { Telegraf } from 'telegraf';
import { createBot } from './bot';
import { config } from './config';
import { connectDatabase } from './db/mongoose';

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

  const bot = createBot(config.botToken);

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
