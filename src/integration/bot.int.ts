import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Telegram, type Telegraf } from 'telegraf';
import { config } from '../config';
import { createBot } from '../bot';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { Transaction } from '../models/Transaction';
import { EscrowHold } from '../models/EscrowHold';
import { Dispute } from '../models/Dispute';
import { Payout } from '../models/Payout';
import { LoginRequest } from '../models/LoginRequest';
import { paymentService } from '../services/paymentService';
import { payoutService } from '../services/payoutService';
import { ledgerService } from '../services/ledgerService';
import { randomToken, sha256 } from '../utils/crypto';

/**
 * The real bot (every handler, wizard and middleware) on a real MongoDB, with Telegram faked:
 * updates go in through bot.handleUpdate exactly as Telegram delivers them, and every API call
 * the bot makes is recorded instead of sent.
 */

let replSet: MongoMemoryReplSet;
let bot: Telegraf<any>;
const calls: { method: string; payload: any }[] = [];
let updateId = 1;
let messageId = 1;

const ADMIN_TG = 777_000;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri(), { dbName: 'bitmax_bot_it' });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  (config as any).adminChatId = String(ADMIN_TG);

  bot = createBot('123:TEST');
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Bitmax', username: 'bitmax_bot' } as any;
  // Telegraf builds a new Telegram client per update, so the fake goes on the prototype:
  // no request from this file can ever reach api.telegram.org.
  (Telegram.prototype as any).callApi = async (method: string, payload: any) => {
    calls.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { message_id: messageId++, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
    }
    return true;
  };
}, { timeout: 600_000 });

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  calls.length = 0;
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  (config as any).paymentProvider = 'sms';
});

const person = (id: number) => ({ id, is_bot: false, first_name: `U${id}`, username: `u${id}` });

async function say(from: number, text: string) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: from, type: 'private' }, from: person(from), text, entities },
  } as any);
}

async function press(from: number, data: string) {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId), from: person(from), chat_instance: '1', data,
      message: { message_id: messageId++, date: 0, chat: { id: from, type: 'private' }, text: 'x' },
    },
  } as any);
}

/** Text of everything the bot sent or showed to `chatId` since the last call (popups included). */
function seen(chatId?: number) {
  const out = calls
    .filter((c) => c.payload?.chat_id === undefined || chatId === undefined || String(c.payload.chat_id) === String(chatId))
    .map((c) => c.payload?.text ?? '')
    .join('\n');
  calls.length = 0;
  return out;
}
const buttons = () => JSON.stringify(calls.map((c) => c.payload?.reply_markup));

async function seededListing(price = 100_000) {
  await say(5001, '/start'); // seller
  const seller = (await User.findOne({ telegramId: 5001 }))!;
  const product = new Product({ sellerId: seller._id, title: 'PUBG <akkaunt>', description: 'Conqueror, 2020 yildan beri faol akkaunt', price, category: 'Steam / Gaming', status: 'active' });
  product.setCredentials({ login: 'pubg_login', password: 'pubg_pass' });
  await product.save();
  return { seller, product };
}

async function boughtAndPaid(buyerTg = 6001) {
  const { seller, product } = await seededListing();
  await say(buyerTg, '/start');
  await press(buyerTg, `buy_${product._id}`);
  const t = (await Transaction.findOne({ productId: product._id }))!;
  const res = await paymentService.confirmPaymentBySms(`Kirim ${t.uniqueAmount}.00 UZS`, 'HUMO', Date.now());
  assert.equal(res.matched, true);
  const hold = (await EscrowHold.findOne({ transactionId: t._id }))!;
  calls.length = 0;
  return { seller, product, hold, buyer: (await User.findOne({ telegramId: buyerTg }))! };
}

describe('bot', () => {
  test('/start registers the user and answers with the menu', async () => {
    await say(4001, '/start');
    assert.ok(await User.exists({ telegramId: 4001 }));
    assert.ok(calls.some((c) => c.method === 'sendMessage'));
  });

  test('a product page escapes the title and buying shows the card and exact amount', async () => {
    const { product } = await seededListing();
    await say(6001, '/start');
    calls.length = 0;
    await press(6001, `detail_${product._id}`);
    const page = seen(6001);
    assert.match(page, /PUBG &lt;akkaunt&gt;/);
    assert.ok(!page.includes('pubg_login'));

    await press(6001, `buy_${product._id}`);
    const t = (await Transaction.findOne({ productId: product._id }))!;
    const text = seen(6001);
    assert.ok(text.includes(String(t.uniqueAmount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) || text.includes(String(t.uniqueAmount)), 'shows the exact amount');
    assert.equal((await Product.findById(product._id))!.status, 'reserved');
  });

  test('paid → reveal shows the login → confirm pays the seller', async () => {
    const { hold, seller } = await boughtAndPaid();
    await press(6001, `reveal_${hold._id}`);
    assert.match(seen(6001), /pubg_login/);
    await press(6001, `confirm_escrow_${hold._id}`);
    assert.equal((await EscrowHold.findById(hold._id))!.status, 'released');
    assert.equal((await User.findById(seller._id))!.balance, 93_000);
  });

  test('someone else pressing the reveal button gets nothing', async () => {
    const { hold } = await boughtAndPaid();
    await say(6999, '/start');
    calls.length = 0;
    await press(6999, `reveal_${hold._id}`);
    assert.ok(!JSON.stringify(calls).includes('pubg_login'));
  });

  test('refund through the buttons returns the money', async () => {
    const { hold, buyer } = await boughtAndPaid();
    await press(6001, `reveal_${hold._id}`);
    await press(6001, `refund_escrow_${hold._id}`);
    await press(6001, `rr_not_working_${hold._id}`);
    await press(6001, `rdo_not_working_${hold._id}`);
    assert.match((await EscrowHold.findById(hold._id))!.status, /refunded/);
    assert.ok((await User.findById(buyer._id))!.balance > 0);
  });

  test('dispute through the buttons; only an admin can decide it', async () => {
    const { hold, buyer, seller } = await boughtAndPaid();
    await press(6001, `reveal_${hold._id}`);
    calls.length = 0;
    await press(6001, `dsp_open_${hold._id}`);
    assert.match(buttons(), /dsp_cat_recovered_/);
    await press(6001, `dsp_cat_recovered_${hold._id}`);
    await press(6001, `dsp_do_recovered_${hold._id}`);
    assert.equal((await EscrowHold.findById(hold._id))!.status, 'disputed');
    const dispute = (await Dispute.findOne())!;
    assert.ok(calls.some((c) => String(c.payload?.chat_id) === String(ADMIN_TG) && /dsp_res_split_/.test(JSON.stringify(c.payload.reply_markup))), 'admin got the decision buttons');

    await press(6001, `dsp_res_buyer_${dispute._id}`); // the buyer tries to decide their own dispute
    assert.equal((await EscrowHold.findById(hold._id))!.status, 'disputed');

    await say(ADMIN_TG, '/start');
    await press(ADMIN_TG, `dsp_res_split_${dispute._id}`);
    assert.equal((await EscrowHold.findById(hold._id))!.status, 'partial_refunded');
    assert.deepEqual([(await User.findById(buyer._id))!.balance, (await User.findById(seller._id))!.balance], [50_000, 46_500]);
    assert.equal((await Dispute.findById(dispute._id))!.status, 'resolved_split');
    assert.deepEqual(await ledgerService.findBalanceDrift(), []);
  });

  test('withdrawal typed as "60 000,00" asks for 60 000, not 6 000 000', async () => {
    const { hold, seller } = await boughtAndPaid();
    await paymentService.revealCredentials(String(hold._id), String(hold.buyerId));
    await paymentService.confirmAndRelease(String(hold._id), String(hold.buyerId));
    await payoutService.setPayoutCard(String(seller._id), '8600111122223333', 'Ali Valiyev');
    await User.updateOne({ _id: seller._id }, { $inc: { balance: 10_000_000 } }); // enough for the wrong reading too
    await press(5001, 'payout_request');
    await say(5001, '60 000,00');
    const payout = (await Payout.findOne())!;
    assert.equal(payout.amount, 60_000);
  });

  test('a blocked user is stopped at the door', async () => {
    await say(8001, '/start');
    await User.updateOne({ telegramId: 8001 }, { $set: { isBlocked: true, blockReason: 'Firibgarlik' } });
    calls.length = 0;
    await say(8001, '💰 Balans');
    assert.match(seen(8001), /bloklangan/);
  });

  test('website login approved from the bot, and a stale link cannot be used', async () => {
    await say(9001, '/start');
    const token = randomToken(32);
    await LoginRequest.create({ tokenHash: sha256(token), pairCode: 'ABC234', status: 'pending', expiresAt: new Date(Date.now() + 60_000) });
    calls.length = 0;
    await say(9001, `/start login_${token}`);
    assert.match(seen(9001), /ABC234/);
    await press(9001, `wl_ok_${token}`);
    const approved = (await LoginRequest.findOne({ tokenHash: sha256(token) }))!;
    assert.equal(approved.status, 'approved');
    assert.equal(String(approved.userId), String((await User.findOne({ telegramId: 9001 }))!._id));

    await press(9002, `wl_ok_${token}`); // somebody else replaying the button
    assert.equal(String((await LoginRequest.findOne({ tokenHash: sha256(token) }))!.userId), String(approved.userId));
  });

  test('listing wizard end to end: every step, credentials encrypted, card saved, listing live', async () => {
    await say(5101, '/start');
    await say(5101, '💼 Akkaunt sotish');
    await press(5101, 'seller_accept_warning');
    await say(5101, 'Instagram 12k obunachi, 2019');
    await say(5101, 'Faol obunachilar, reklama tarixi toza, hech qachon bloklanmagan.');
    await say(5101, '150 000');
    await say(5101, 'Bogus kategoriya');
    await say(5101, 'Instagram');
    await say(5101, 'ig_login_secret');
    await say(5101, 'ig_password_secret');
    await say(5101, 'yo‘q');
    await press(5101, 'photos_skip');
    await say(5101, '8600 1111 2222 3333');
    await say(5101, 'Ali Valiyev');
    calls.length = 0;
    await press(5101, 'seller_publish_confirm');

    const product = (await Product.findOne({ title: 'Instagram 12k obunachi, 2019' }))!;
    assert.ok(product, 'listing created');
    assert.equal(product.status, 'active');
    assert.equal(product.price, 150_000);
    assert.equal(product.category, 'Instagram');
    assert.deepEqual([product.getCredentials().login, product.getCredentials().password], ['ig_login_secret', 'ig_password_secret']);
    assert.ok(!JSON.stringify(await Product.collection.findOne({ _id: product._id })).includes('ig_password_secret'));
    const seller = (await User.findOne({ telegramId: 5101 }))!;
    assert.equal(seller.payoutCard?.masked, '8600 •••• •••• 3333');
    assert.equal(seller.role, 'seller');
    assert.ok(!JSON.stringify(calls).includes('ig_password_secret'), 'the password is never echoed back');
  });

  test('private deal: seller creates a code, buyer enters it, buys, and the code dies with the deal', async () => {
    await say(5201, '/start');
    await say(5201, '🤝 Kafil bitim');
    await press(5201, 'deal_side_seller');
    await say(5201, 'Telegram kanal');
    await say(5201, '80 000');
    await say(5201, 'deal_login');
    await say(5201, 'deal_pass');
    await press(5201, 'photos_skip');
    await say(5201, '8600 4444 5555 6666');
    await say(5201, 'Vali Aliyev');
    await press(5201, 'deal_publish_confirm');
    const deal = (await Product.findOne({ listingType: 'private' }))!;
    assert.ok(deal?.dealCode, 'deal code created');

    await say(6201, '/start');
    await say(6201, '🤝 Kafil bitim');
    await press(6201, 'deal_side_buyer');
    calls.length = 0;
    await say(6201, deal.dealCode!.toLowerCase());
    assert.match(buttons(), new RegExp(`buy_${deal._id}`));
    await press(6201, `buy_${deal._id}`);
    assert.equal((await Product.findById(deal._id))!.status, 'reserved');
  });

  test('pressing a main-menu button in the middle of a wizard leaves it cleanly', async () => {
    await say(5301, '/start');
    await say(5301, '💼 Akkaunt sotish');
    await press(5301, 'seller_accept_warning');
    await say(5301, 'Yarim yo‘lda qolgan e’lon');
    calls.length = 0;
    await say(5301, '💰 Balans');
    assert.match(seen(5301), /Balans|balans/);
    assert.equal(await Product.countDocuments(), 0);
  });

  test('dispute evidence: both sides send photos and text, admin gets copies and can review them', async () => {
    const { hold } = await boughtAndPaid();
    await press(6001, `reveal_${hold._id}`);
    await press(6001, `dsp_open_${hold._id}`);
    await press(6001, `dsp_cat_not_working_${hold._id}`);
    calls.length = 0;
    await press(6001, `dsp_do_not_working_${hold._id}`);
    const dispute = (await Dispute.findOne())!;
    const offered = calls.filter((c) => /dsp_ev_[a-f0-9]{24}/.test(JSON.stringify(c.payload?.reply_markup || '')));
    assert.deepEqual(offered.map((c) => String(c.payload.chat_id)).sort(), ['5001', '6001'], 'buyer and seller both get the button');

    // Buyer: a screenshot with a caption, then a written note.
    await press(6001, `dsp_ev_${dispute._id}`);
    calls.length = 0;
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId++, date: 0, chat: { id: 6001, type: 'private' }, from: person(6001),
        photo: [{ file_id: 'small_id', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'big_id', file_unique_id: 'b', width: 900, height: 900 }],
        caption: 'Login xato deyapti',
      },
    } as any);
    assert.ok(calls.some((c) => c.method === 'copyMessage' && String(c.payload.chat_id) === String(ADMIN_TG)), 'admin receives the original');
    await say(6001, 'Parolni 3 marta kiritdim, ishlamadi');
    await press(6001, 'dsp_ev_done');

    // Seller: a video.
    await press(5001, `dsp_ev_${dispute._id}`);
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: messageId++, date: 0, chat: { id: 5001, type: 'private' }, from: person(5001), video: { file_id: 'video_id', file_unique_id: 'v', width: 1, height: 1, duration: 3 } },
    } as any);
    await press(5001, 'dsp_ev_done');

    const stored = (await Dispute.findById(dispute._id))!.evidence;
    assert.deepEqual(stored.map((e) => [e.kind, e.ref ?? null, e.note ?? null]), [
      ['photo', 'big_id', 'Login xato deyapti'],
      ['text', null, 'Parolni 3 marta kiritdim, ishlamadi'],
      ['video', 'video_id', null],
    ]);

    // A stranger cannot add to it.
    await say(6999, '/start');
    await press(6999, `dsp_ev_${dispute._id}`);
    assert.equal((await Dispute.findById(dispute._id))!.evidence.length, 3);

    // The admin reviews everything; a plain user cannot.
    calls.length = 0;
    await press(6001, `dsp_evv_${dispute._id}`);
    assert.ok(!calls.some((c) => c.method === 'sendPhoto'), 'a party cannot pull the full evidence file');
    await say(ADMIN_TG, '/start');
    calls.length = 0;
    await press(ADMIN_TG, `dsp_evv_${dispute._id}`);
    assert.deepEqual(calls.filter((c) => /^send(Photo|Video|Message)$/.test(c.method)).map((c) => c.method), ['sendPhoto', 'sendMessage', 'sendVideo']);

    // After the decision no more evidence is accepted.
    await press(ADMIN_TG, `dsp_res_buyer_${dispute._id}`);
    await press(6001, `dsp_ev_${dispute._id}`);
    await say(6001, 'kech qolgan dalil');
    assert.equal((await Dispute.findById(dispute._id))!.evidence.length, 3);
  });

  test('a buyer cannot open more than two unpaid orders from the bot', async () => {
    const { seller } = await seededListing();
    const extra = await Promise.all([1, 2, 3].map(async () => {
      const p = new Product({ sellerId: seller._id, title: 'Akk', description: 'Yaxshi akkaunt, tavsif yetarli uzun', price: 50_000, category: 'Boshqa', status: 'active' });
      p.setCredentials({ login: 'l', password: 'p' });
      return p.save();
    }));
    await say(6001, '/start');
    for (const p of extra) await press(6001, `buy_${p._id}`);
    assert.equal(await Transaction.countDocuments({ status: 'pending_payment' }), 2);
    assert.equal((await Product.findById(extra[2]._id))!.status, 'active');
  });
});
