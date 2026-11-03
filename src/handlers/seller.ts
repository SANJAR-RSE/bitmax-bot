import { Composer, Scenes } from 'telegraf';
import { Types } from 'mongoose';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { payoutService } from '../services/payoutService';
import { Product } from '../models/Product';
import { describeError } from '../utils/errors';
import { User } from '../models/User';
import { botApi } from '../services/botApi';
import { CATEGORIES } from '../categories';
import { notificationService } from '../services/notificationService';
import { config } from '../config';
import { escapeHtml, formatUzs, formatDealCode, isValidUzCard, maskCard } from '../utils/helpers';
import { uploadTelegramPhoto, ImageUploadError } from '../services/cloudinaryService';
import { bailIfCancelled } from '../wizards/guard';
import {
  confirmSellerWarning,
  sellerMenuKeyboard,
  backButton,
  mainMenuKeyboard,
  dealSideButtons,
  photoStepButtons,
} from '../keyboards';

export const sellerHandler = new Composer();

const SELLER_WIZARD = 'seller_create';
export const DEAL_WIZARD = 'deal_create';

/** Renders the running photo-collection prompt so both wizards show the same wording. */
function photoStepPrompt(count: number): string {
  return [
    `<b>📷 Mahsulot rasmlari</b>`,
    '',
    `Rasmlarni bittalab yuboring (ixtiyoriy, jami ${config.maxProductImages} tagacha).`,
    `Tugatgach “Tayyor” tugmasini bosing.`,
    '',
    count > 0 ? `<i>Qo‘shildi: ${count}/${config.maxProductImages}</i>` : `<i>Hali rasm yo‘q.</i>`,
  ].join('\n');
}

/**
 * One photo-collection step shared by both wizards' step arrays. Each call handles either an
 * incoming photo (uploads it and stays on this step) or the "done"/"skip" callback (hands off
 * to `onFinish`, which renders that wizard's own review screen and advances the cursor).
 */
function makePhotoStep(sessionKey: 'productData' | 'dealData', onFinish: (ctx: any) => Promise<void>) {
  return async (ctx: any) => {
    if (await bailIfCancelled(ctx, [sessionKey])) return;

    const images: string[] = ctx.session[sessionKey].images || [];

    const data = ctx.callbackQuery?.data;
    if (data === 'photos_done' || data === 'photos_skip') {
      await ctx.answerCbQuery();
      await onFinish(ctx);
      return;
    }

    const photoSizes = ctx.message?.photo;
    if (photoSizes?.length) {
      if (images.length >= config.maxProductImages) {
        await ctx.reply(`Allaqachon ${config.maxProductImages} tadan rasm qo‘shilgan — “Tayyor” ni bosing.`);
        return;
      }

      const largest = photoSizes[photoSizes.length - 1];
      try {
        const url = await uploadTelegramPhoto(ctx.telegram, largest.file_id);
        images.push(url);
        ctx.session[sessionKey].images = images;

        if (images.length >= config.maxProductImages) {
          await ctx.reply(`✅ ${config.maxProductImages}/${config.maxProductImages} rasm qo‘shildi, davom etamiz.`);
          await onFinish(ctx);
          return;
        }

        await ctx.replyWithHTML(photoStepPrompt(images.length), photoStepButtons(images.length));
      } catch (error: any) {
        const message = error instanceof ImageUploadError ? error.message : 'Rasm yuklanmadi, qayta urinib ko‘ring.';
        await ctx.reply(`⚠️ ${message}`);
      }
      return;
    }

    // Anything else (stray text) — just remind them what's expected instead of silently
    // dropping it, since a wizard step with no reply looks broken.
    await ctx.replyWithHTML(photoStepPrompt(images.length), photoStepButtons(images.length));
  };
}

sellerHandler.hears(["💼 Akkaunt sotish","Akkaunt sotish","➕ Yangi e’lon","Yangi e’lon"], async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user) return;

  if (user.isBlocked) {
    await ctx.reply('❌ Hisobingiz bloklangan.');
    return;
  }

  if (user.role === 'buyer') {
    user.role = 'seller';
    await user.save();
  }

  await (ctx as any).scene.enter(SELLER_WIZARD);
});

/**
 * The escrow-only path, shown as its own menu entry because it is a different job from
 * listing on the marketplace: the two people already agreed, they just want a guarantor.
 */
sellerHandler.hears(["🤝 Kafil bitim (escrow)","Kafil bitim (escrow)","🤝 Kafil bitim","Kafil bitim"], async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user || user.isBlocked) return;

  await ctx.replyWithHTML(
    [
      `<b>🤝 Kafil bitim</b>`,
      '',
      `Xaridor va sotuvchi allaqachon kelishgan bo‘lsa, Bitmax o‘rtada turadi:`,
      `pul kafilda saqlanadi, xaridor akkauntni tekshiradi, keyin pul sotuvchiga o‘tadi.`,
      '',
      `• Katalogda ko‘rinmaydi — faqat kod bilan ochiladi`,
      `• Moderatsiya kutilmaydi, darhol ishlaydi`,
      `• Komissiya ${config.platformCommission}% (sotuvchidan)`,
      '',
      `<i>Siz qaysi tomondasiz?</i>`,
    ].join('\n'),
    dealSideButtons()
  );
});

sellerHandler.action('deal_side_seller', async (ctx) => {
  await ctx.answerCbQuery();
  await (ctx as any).scene?.enter(DEAL_WIZARD);
});

sellerHandler.action('deal_side_buyer', async (ctx) => {
  await ctx.answerCbQuery();
  await (ctx as any).scene?.enter('deal_code');
});

sellerHandler.action('seller_accept_warning', async (ctx) => {
  await ctx.answerCbQuery();
  await (ctx as any).scene?.enter(SELLER_WIZARD);
});

sellerHandler.action('seller_cancel', async (ctx) => {
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.reply('Bekor qilindi.', mainMenuKeyboard);
});

sellerHandler.action(/^deal_cancel_(.+)$/, async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user) return void ctx.answerCbQuery('Topilmadi');

  const cancelled = await botApi.cancelDeal(ctx.match[1], String(user._id)).catch(() => null);
  if (!cancelled) {
    await ctx.answerCbQuery('Bitim topilmadi yoki allaqachon boshlangan');
    return;
  }

  await ctx.editMessageText('❌ Bitim bekor qilindi, kod ishlamaydi.', { parse_mode: 'HTML' });
  await ctx.answerCbQuery('Bekor qilindi');
});

const listingStatus: Record<string, string> = {
  active: 'Sotuvda', pending_review: 'Tekshirilmoqda', rejected: 'Rad etilgan', reserved: 'To‘lov kutilmoqda',
  sold: 'Sotilgan', refunded: 'Qaytarilgan', disputed: 'Nizoda', archived: 'Bekor qilingan', draft: 'Qoralama',
};
async function showMyListings(ctx: any, requestedPage = 1, edit = false) {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return;
  const count = await Product.countDocuments({ sellerId: user._id });
  const pages = Math.max(1, Math.ceil(count / 10));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const products = await Product.find({ sellerId: user._id }).select('-sensitiveData').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 10).limit(10);
  const rows: any[][] = products.map(p => [{ text: `${p.listingCode || '—'} · ${p.title.slice(0, 35)} · ${listingStatus[p.status]}`, callback_data: `my_listing_${p._id}` }]);
  const pager = [];
  if (page > 1) pager.push({ text: '← Oldingi', callback_data: `my_listings_${page - 1}` });
  if (page < pages) pager.push({ text: 'Keyingi →', callback_data: `my_listings_${page + 1}` });
  if (pager.length) rows.push(pager);
  rows.push([{ text: '＋ Yangi e’lon', callback_data: 'seller_accept_warning' }]);
  const text = `<b>E’lonlarim</b> · ${page}/${pages}\n\n${count ? 'Batafsil ko‘rish yoki bekor qilish uchun e’lonni tanlang.' : 'Hali e’lon yo‘q. Birinchi akkauntingizni sotuvga qo‘ying.'}`;
  const options = { parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: rows } };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}
sellerHandler.hears(['📋 E’lonlarim', 'E’lonlarim', '📋 Mening e’lonlarim', 'Mening e’lonlarim'], ctx => showMyListings(ctx));
sellerHandler.action(/^my_listings_(\d+)$/, async ctx => { await ctx.answerCbQuery(); await showMyListings(ctx, Number(ctx.match[1]), true); });
sellerHandler.action(/^my_listing_([a-f0-9]{24})$/, async ctx => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const p = user && await Product.findOne({ _id: ctx.match[1], sellerId: user._id }).select('-sensitiveData');
  if (!p) return void await ctx.answerCbQuery('E’lon topilmadi');
  await ctx.answerCbQuery();
  const rows: any[][] = [];
  if (['active', 'pending_review', 'draft', 'rejected'].includes(p.status)) rows.push([{ text: 'E’lonni bekor qilish', callback_data: `listing_cancel_ask_${p._id}` }]);
  rows.push([{ text: '← E’lonlarim', callback_data: 'my_listings_1' }]);
  await ctx.editMessageText([
    `<b>${escapeHtml(p.title)}</b>`, `ID: <code>${p.listingCode || '—'}</code>`,
    `Narx: <b>${formatUzs(p.price)}</b>`, `Holat: ${listingStatus[p.status]}`,
    p.listingType === 'private' && p.dealCode && p.status === 'active' ? `Bitim kodi: <code>${formatDealCode(p.dealCode)}</code>` : '',
    '', 'Band qilingan yoki sotilgan e’lonni bekor qilib bo‘lmaydi.',
  ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
});
sellerHandler.action(/^listing_cancel_ask_([a-f0-9]{24})$/, async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('E’lonni bekor qilasizmi? U katalogdan olib tashlanadi. Qayta sotish uchun yangi e’lon yaratasiz.', { reply_markup: { inline_keyboard: [
    [{ text: 'Ha, bekor qilish', callback_data: `listing_cancel_do_${ctx.match[1]}` }],
    [{ text: 'Ortga qaytish', callback_data: `my_listing_${ctx.match[1]}` }],
  ] } });
});
sellerHandler.action(/^listing_cancel_do_([a-f0-9]{24})$/, async ctx => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const cancelled = user && await botApi.cancelListing(ctx.match[1], String(user._id));
  if (!cancelled) return void await ctx.answerCbQuery('E’lon topilmadi yoki savdo boshlangan', { show_alert: true });
  await ctx.answerCbQuery('E’lon bekor qilindi');
  await showMyListings(ctx, 1, true);
});

sellerHandler.hears(["📊 Statistika","Statistika"], async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user || user.role === 'admin') return; // admin has its own stats screen

  const products = await botApi.getUserProducts(user._id.toString());
  const activeCount = products.filter((p) => p.status === 'active').length;
  const rating = user.averageRating();

  await ctx.replyWithHTML(
    [
      `<b>📊 Sotuvchi statistikasi</b>`,
      '',
      `Daraja: <b>${user.trustLevel}</b>`,
      `Reyting: ${rating ? `⭐ ${rating} (${user.sellerStats.ratingCount} baho)` : 'hali baho yo‘q'}`,
      '',
      `Faol e’lonlar: ${activeCount}`,
      `Sotilgan: ${user.sellerStats.sold}`,
      `Qaytarilgan: ${user.sellerStats.refunded}`,
      `Yo‘qotilgan nizolar: ${user.sellerStats.disputesLost}`,
      '',
      `Balans: <b>${formatUzs(user.balance)}</b>`,
      `Umumiy daromad: ${formatUzs(user.totalEarned)}`,
    ].join('\n')
  );
});

/** Shared review-screen renderer for the private deal wizard (mirrors the public wizard's). */
async function renderDealReview(ctx: any) {
  const data = ctx.session.dealData;
  const commission = Math.round((data.price * config.platformCommission) / 100);
  const images: string[] = data.images || [];

  await ctx.replyWithHTML(
    [
      `<b>📋 Bitimni tekshirib chiqing</b>`,
      '',
      `<b>Nomi:</b> ${escapeHtml(data.title)}`,
      `<b>Narx:</b> ${formatUzs(data.price)}`,
      `<b>Login:</b> ${escapeHtml(data.login)}`,
      `<b>Parol:</b> ${'•'.repeat(Math.min(12, data.password.length))}`,
      `<b>Rasmlar:</b> ${images.length > 0 ? `${images.length} ta` : 'yo‘q'}`,
      '',
      `<b>Siz olasiz:</b> ${formatUzs(data.price - commission)}`,
      `<b>Komissiya:</b> ${formatUzs(commission)}`,
      '',
      `<i>Tasdiqlagach kod darhol yaratiladi va o‘zgartirib bo‘lmaydi — xato bo‘lsa, bekor qilib qaytadan boshlang.</i>`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Kodni yaratish', callback_data: 'deal_publish_confirm' },
            { text: '❌ Bekor qilish', callback_data: 'deal_publish_cancel' },
          ],
        ],
      },
    }
  );
  return ctx.wizard.next();
}

/**
 * Private deal wizard — four questions instead of the catalog listing's seven, plus an optional
 * photo step and a confirm/review screen before anything is actually created.
 *
 * Everything the public form asks for in order to *sell* the listing to a stranger (long
 * description, category, tags) is dead weight here: the buyer already knows what they're
 * getting and is waiting for the code. Asking anyway is how a one-minute handover turns into
 * an abandoned form.
 */
export function createDealWizard() {
  return new Scenes.WizardScene<any>(
    DEAL_WIZARD,
    async (ctx: any) => {
      ctx.session.dealData = {};
      await ctx.replyWithHTML(
        [
          `<b>🤝 Kelishilgan bitim — 1/4</b>`,
          '',
          `Nima sotyapsiz? Qisqa nom yozing:`,
          `<i>masalan: “Instagram @mynick” yoki “Steam akkaunt CS2”</i>`,
          '',
          `<i>Istalgan qadamda "Asosiy menu" ni bosib bekor qilishingiz mumkin.</i>`,
        ].join('\n'),
        backButton()
      );
      return ctx.wizard.next();
    },

    // Step 2 — title
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['dealData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text || text.length < 3 || text.length > 120) {
        await ctx.reply('Nom 3–120 belgi bo‘lishi kerak. Qaytadan kiriting:');
        return;
      }
      ctx.session.dealData.title = text;

      await ctx.replyWithHTML(
        [`<b>🤝 2/4 — Narx</b>`, '', `Kelishilgan summani so‘mda kiriting (faqat raqam):`].join('\n')
      );
      return ctx.wizard.next();
    },

    // Step 3 — price
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['dealData'])) return;

      const rawPrice = String(ctx.message?.text || '').trim();
      const price = /^\d[\d\s]*$/.test(rawPrice) ? Number(rawPrice.replace(/\s/g, '')) : NaN;
      if (!Number.isSafeInteger(price) || price < 1000 || price > 1_000_000_000) {
        await ctx.reply(
          `Minimal summa 1 000 UZS. “${escapeHtml(ctx.session.dealData.title)}” uchun narxni qaytadan kiriting:`
        );
        return;
      }

      ctx.session.dealData.price = price;
      const commission = Math.round((price * config.platformCommission) / 100);

      await ctx.replyWithHTML(
        [
          `<b>🤝 3/4 — Akkaunt logini</b>`,
          '',
          `<i>Siz olasiz: <b>${formatUzs(price - commission)}</b> (komissiya ${formatUzs(commission)})</i>`,
          '',
          `🔐 Login (email yoki username) ni kiriting:`,
          `<i>Shifrlangan saqlanadi, xaridor faqat to‘lovdan keyin ko‘radi.</i>`,
        ].join('\n')
      );
      return ctx.wizard.next();
    },

    // Step 4 — login
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['dealData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply('Iltimos, loginni kiriting:');
        return;
      }
      ctx.session.dealData.login = text;
      await ctx.reply('🔐 4/4 — Parolni kiriting:');
      return ctx.wizard.next();
    },

    // Step 5 — password, then hand off to the photo step
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['dealData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply('Iltimos, parolni kiriting:');
        return;
      }
      ctx.session.dealData.password = text;
      ctx.session.dealData.images = [];

      await ctx.replyWithHTML(photoStepPrompt(0), photoStepButtons(0));
      return ctx.wizard.next();
    },

    // Step 6 — photo collection (optional, up to config.maxProductImages)
    makePhotoStep('dealData', renderDealReview),

    // Step 7 — review confirm/cancel
    async (ctx: any) => {
      const action = ctx.callbackQuery?.data;

      if (action !== 'deal_publish_confirm') {
        await ctx.answerCbQuery?.('Bekor qilindi');
        ctx.session.dealData = {};
        await ctx.reply('Bitim yaratish bekor qilindi.', sellerMenuKeyboard);
        return ctx.scene.leave();
      }

      const user = await User.findOne({ telegramId: ctx.from!.id });
      if (!user) return ctx.scene.leave();

      const data = ctx.session.dealData;
      const deal = await botApi.createDeal({ sellerId: String(user._id), ...data });

      // Wipe the plaintext password out of the session the moment it is persisted.
      ctx.session.dealData = {};

      const commission = Math.round((deal.price * config.platformCommission) / 100);
      const code = formatDealCode(deal.dealCode!);

      await ctx.answerCbQuery('Yaratildi');
      await ctx.editMessageText(
        [
          `✅ <b>Bitim tayyor!</b>`,
          '',
          `<b>${escapeHtml(deal.title)}</b>`,
          `Summa: <b>${formatUzs(deal.price)}</b>`,
          `Siz olasiz: <b>${formatUzs(deal.price - commission)}</b>`,
          '',
          `<b>🔑 Xaridorga shu kodni yuboring:</b>`,
          `<code>${code}</code>`,
          '',
          `<i>Xaridor botga kirib “🔑 Kod bilan sotib olish” ni bosadi va shu kodni kiritadi.</i>`,
          '',
          `⏳ Kod 7 kun amal qiladi — muddati o‘tsa, sizga xabar beramiz.`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📤 Xaridorga yuborish',
                  // Prefilled forward: the seller picks the chat and Telegram sends the text.
                  switch_inline_query: `\n\n🤝 Bitmax kafil bitimi\n${deal.title}\nSumma: ${formatUzs(deal.price)}\nKod: ${code}\n\nhttps://t.me/${config.botUsername}`,
                },
              ],
              [{ text: '❌ Bitimni bekor qilish', callback_data: `deal_cancel_${deal._id}` }],
            ],
          },
        }
      );

      await ctx.reply('Asosiy menu', sellerMenuKeyboard);
      return ctx.scene.leave();
    }
  );
}

/** Shared review-screen renderer for the public listing wizard. */
async function renderProductReview(ctx: any) {
  const data = ctx.session.productData;
  const commission = Math.round((data.price * config.platformCommission) / 100);
  const images: string[] = data.images || [];

  await ctx.replyWithHTML(
    [
      `<b>📋 E’lonni tekshirib chiqing</b>`,
      '',
      `<b>Nomi:</b> ${escapeHtml(data.title)}`,
      `<b>Tavsif:</b> ${escapeHtml(data.description.slice(0, 300))}`,
      `<b>Narx:</b> ${formatUzs(data.price)}`,
      `<b>Kategoriya:</b> ${escapeHtml(data.category)}`,
      '',
      `<b>Login:</b> ${escapeHtml(data.login)}`,
      `<b>Parol:</b> ${'•'.repeat(Math.min(12, data.password.length))}`,
      `<b>Tiklash kodi:</b> ${data.recoveryCode ? 'kiritilgan' : 'yo‘q'}`,
      `<b>Rasmlar:</b> ${images.length > 0 ? `${images.length} ta` : 'yo‘q'}`,
      '',
      `<b>Siz olasiz:</b> ${formatUzs(data.price - commission)}`,
      `<b>Komissiya:</b> ${formatUzs(commission)}`,
      '',
      `<b>Karta:</b> ${escapeHtml(data.cardMasked)}`,
      `<b>Karta egasi:</b> ${escapeHtml(data.cardHolder)}`,
      '',
      `<i>Tasdiqlagach e’lon darhol katalogda chiqadi. Komissiya muvaffaqiyatli savdodan ushlanadi.</i>`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Tasdiqlash va e’lon berish', callback_data: 'seller_publish_confirm' },
            { text: '❌ Bekor qilish', callback_data: 'seller_publish_cancel' },
          ],
        ],
      },
    }
  );
  return ctx.wizard.next();
}

/**
 * Listing wizard. Each step validates before advancing so a bad value can't reach the
 * database, and the state lives in the Mongo-backed session so a restart mid-wizard no longer
 * loses everything the seller typed.
 */
export function createSellerWizard() {
  return new Scenes.WizardScene<any>(
    SELLER_WIZARD,
    async (ctx: any) => {
      ctx.session.productData = { productId: new Types.ObjectId().toString() };
      await ctx.replyWithHTML(
        '<b>1. Nomi</b>\n\nMahsulot nomini kiriting (masalan: “Instagram 12k obunachi, 2019”):\n\n' +
          '<i>Istalgan qadamda "Asosiy menu" ni bosib bekor qilishingiz mumkin.</i>',
        backButton()
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text || text.length < 5 || text.length > 120) {
        await ctx.reply('Nom 5–120 belgi bo‘lishi kerak. Qaytadan kiriting:');
        return;
      }
      ctx.session.productData.title = text;
      await ctx.replyWithHTML(
        '<b>2. Tavsif</b>\n\nAkkaunt haqida batafsil yozing (obunachilar, yosh, geografiya, ' +
          'nima uchun sotilyapti):'
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text || text.length < 20) {
        await ctx.reply(
          `Tavsif kamida 20 belgi bo‘lishi kerak. “${escapeHtml(ctx.session.productData.title)}” haqida batafsil yozing:`
        );
        return;
      }
      ctx.session.productData.description = text.slice(0, 4000);
      await ctx.replyWithHTML(
        `<b>3. Narx</b>\n\nNarxni so‘mda kiriting (faqat raqam, masalan: 250000):`
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const rawPrice = String(ctx.message?.text || '').trim();
      const price = /^\d[\d\s]*$/.test(rawPrice) ? Number(rawPrice.replace(/\s/g, '')) : NaN;
      if (!Number.isSafeInteger(price) || price < 1000 || price > 1_000_000_000) {
        await ctx.reply('Narx 1 000–1 000 000 000 so‘m orasida bo‘lsin. Faqat butun raqam kiriting:');
        return;
      }

      ctx.session.productData.price = price;
      const { commission, sellerPayout } = {
        commission: Math.round((price * config.platformCommission) / 100),
        sellerPayout: price - Math.round((price * config.platformCommission) / 100),
      };

      await ctx.replyWithHTML(
        `<b>4. Kategoriya</b>\n\n` +
          `<i>Bu narxda siz olasiz: ${formatUzs(sellerPayout)} (komissiya ${formatUzs(commission)})</i>\n\n` +
          `Kategoriyani tanlang:`,
        {
          reply_markup: {
            keyboard: CATEGORIES.map((c) => [c]),
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text || !CATEGORIES.includes(text)) {
        await ctx.reply('Iltimos, ro‘yxatdagi kategoriyalardan birini tanlang:');
        return;
      }
      ctx.session.productData.category = text;
      await ctx.replyWithHTML(
        `<b>5. Login</b>\n\n🔐 Akkaunt login (email yoki username) ni kiriting:\n\n` +
          `<i>Bu ma’lumot shifrlangan holda saqlanadi va faqat to‘lov tasdiqlangach ` +
          `xaridorga ochiladi.</i>`,
        backButton()
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply('Iltimos, loginni kiriting:');
        return;
      }
      ctx.session.productData.login = text;
      await ctx.reply('6. Parolni kiriting:');
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply('Iltimos, parolni kiriting:');
        return;
      }
      ctx.session.productData.password = text;
      await ctx.reply('7. Tiklash kodi / qo‘shimcha ma’lumot (bo‘lmasa "yo‘q" deb yozing):');
      return ctx.wizard.next();
    },

    // Recovery code, then hand off to the photo step
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;

      const text = ctx.message?.text?.trim();
      ctx.session.productData.recoveryCode =
        !text || /^(yo['’]?q|yoq|no|-)$/i.test(text) ? undefined : text;
      ctx.session.productData.images = [];

      await ctx.replyWithHTML(photoStepPrompt(0), photoStepButtons(0));
      return ctx.wizard.next();
    },

    // Photo collection (optional, up to config.maxProductImages)
    makePhotoStep('productData', async ctx => {
      await ctx.replyWithHTML('<b>To‘lov kartangiz</b>\n\nSavdodan tushgan pulni yechish uchun 16 xonali karta raqamingizni kiriting. Karta xaridorlarga ko‘rsatilmaydi.');
      return ctx.wizard.next();
    }),
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;
      const raw = ctx.message?.text?.trim() || '';
      if (!/^[\d\s]+$/.test(raw) || !isValidUzCard(raw)) return ctx.reply('16 xonali karta raqamini kiriting. Masalan: 8600 1234 5678 9012.');
      ctx.session.productData.cardEncrypted = encryptSecret(raw.replace(/\s/g, ''));
      ctx.session.productData.cardMasked = maskCard(raw);
      await ctx.deleteMessage().catch(() => undefined);
      await ctx.replyWithHTML('<b>Karta egasi</b>\n\nKartadagi ism va familiyani kiriting. Masalan: Ali Valiyev.');
      return ctx.wizard.next();
    },
    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['productData'])) return;
      const holder = ctx.message?.text?.trim().replace(/\s+/g, ' ');
      if (!holder || holder.length > 80 || holder.split(' ').length < 2 || !/^[\p{L}\p{M} ’‘'ʼ-]+$/u.test(holder)) return ctx.reply('Karta egasining ism va familiyasini to‘liq kiriting.');
      ctx.session.productData.cardHolder = holder;
      return renderProductReview(ctx);
    },

    // Review confirm/cancel
    async (ctx: any) => {
      const action = ctx.callbackQuery?.data;

      if (await bailIfCancelled(ctx, ['productData'])) return;
      if (!['seller_publish_confirm', 'seller_publish_cancel'].includes(action)) return ctx.reply('Quyidagi tasdiqlash yoki bekor qilish tugmasini bosing.');
      if (action === 'seller_publish_cancel') {
        ctx.session.productData = {};
        await ctx.answerCbQuery?.('Bekor qilindi');
        await ctx.reply('E’lon yaratish bekor qilindi.', sellerMenuKeyboard);
        return ctx.scene.leave();
      }

      const user = await User.findOne({ telegramId: ctx.from!.id });
      if (!user) {
        await ctx.reply('Xatolik yuz berdi. /start bosib qaytadan urinib ko‘ring.');
        return ctx.scene.leave();
      }

      const data = ctx.session.productData;
      await ctx.answerCbQuery('E’lon saqlanmoqda…');
      if (!data.cardEncrypted || !data.cardHolder) return ctx.reply('Karta ma’lumotlari topilmadi. /cancel orqali chiqib, e’lonni qayta yarating.');
      let product;
      try {
        await payoutService.setPayoutCard(String(user._id), decryptSecret(data.cardEncrypted), data.cardHolder);
        product = await botApi.createProduct({ sellerId: user._id.toString(), ...data });
      } catch (error) {
        await ctx.reply(describeError(error) + ' Ma’lumotlar saqlanib turibdi. Tasdiqlashni qayta bosing yoki /cancel yozing.');
        return;
      }

      // Clear the plaintext credentials out of the session as soon as they're persisted —
      // no reason to leave a live password sitting in a session document.
      ctx.session.productData = {};
      await ctx.scene.leave();

      await ctx.replyWithHTML(
        `✅ <b>E’lon katalogda!</b>\n\n${escapeHtml(product.title)}\n` +
          `ID: <code>${product.listingCode}</code>\nNarx: ${formatUzs(product.price)}\n\n` +
          `Xaridor shu ID’ni botga yuborib e’lonni ochishi mumkin. E’lonni “E’lonlarim” bo‘limida bekor qilasiz.`,
        sellerMenuKeyboard
      );

      await notificationService.notifyAdmin(
        `🆕 <b>Yangi e’lon katalogda</b>\n\n` +
          `${escapeHtml(product.title)}\n${formatUzs(product.price)}\n` +
          `Sotuvchi: @${escapeHtml(user.username || String(user.telegramId))} (${user.trustLevel})\n\n` +
          `<i>E’lon katalogda chop etildi.</i>`
      );

      return ctx.scene.leave();
    }
  );
}
