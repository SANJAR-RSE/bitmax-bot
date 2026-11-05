import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config';
import { notificationService } from './notificationService';

test('without a Telegraf instance, messages go straight to the Bot API', async () => {
  const realFetch = globalThis.fetch;
  const realToken = config.botToken;
  const calls: { url: string; body: any }[] = [];
  config.botToken = 'test-token';
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  try {
    const sent = await notificationService.send({
      type: 'buyer',
      chatId: 42,
      message: '<b>salom</b>',
      buttons: [[{ text: 'A', callback_data: 'a' }]],
    });
    assert.equal(sent, true);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.equal(calls[0].body.chat_id, '42');
    assert.equal(calls[0].body.parse_mode, 'HTML');
    assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [[{ text: 'A', callback_data: 'a' }]]);

    // A refusal is reported as not sent, so callers that track delivery can retry later.
    globalThis.fetch = (async () => new Response('{"description":"Forbidden"}', { status: 403 })) as typeof fetch;
    assert.equal(await notificationService.send({ type: 'buyer', chatId: 42, message: 'x' }), false);
  } finally {
    globalThis.fetch = realFetch;
    config.botToken = realToken;
  }
});
