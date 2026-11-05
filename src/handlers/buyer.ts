import { Composer, Scenes } from 'telegraf';
import { sendCatalogPage, sendProductDetail } from './catalog';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { EscrowHold } from '../models/EscrowHold';
import { Transaction } from '../models/Transaction';
import { botApi } from '../services/botApi';
import { notificationService } from '../services/notificationService';
import { paymentService } from '../services/paymentService';
import { describeRefundPolicy } from '../services/refundEngine';
import { config } from '../config';
import { escapeHtml, formatUzs, formatDeadline, formatCardNumber } from '../utils/helpers';
import { bailIfCancelled } from '../wizards/guard';
import { describeError } from '../utils/errors';
import {
  mainMenuKeyboard,
  backButton,
  productActionButtons,
  revealButton,
  escrowActionButtons,
  refundReasonButtons,
  refundConfirmButtons,
  dealBuyButtons,
  codeRetryButton,
  catalogPageButtons,
} from '../keyboards';

export const buyerHandler = new Composer();

export const CODE_WIZARD = 'deal_code';

/**
 * Scene where a buyer redeems a seller's deal code.
 *
 * The attempt counter matters: the code is the only thing standing between a stranger and a
 * private deal, so an unlimited prompt would let someone sit here grinding guesses. Three
 * tries and the scene closes — with a button to start over instead of a dead end.
 */
export function createCodeWizard() {
  return new Scenes.WizardScene<any>(
    CODE_WIZARD,
    async (ctx: any) => {
      ctx.session.codeTries = 0;
      await ctx.replyWithHTML(
        [
          `<b>🔑 Bitim kodi</b>`,
          '',
          `Sotuvchi bergan 8 belgili kodni kiriting:`,
          `<i>masalan: ABCD-2345</i>`,
        ].join('\n'),
        backButton()
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx, ['codeTries'])) return;

      const raw = ctx.message?.text?.trim();
      if (!raw) return;

      const user = await User.findOne({ telegramId: ctx.from!.id });
      if (!user) return ctx.scene.leave();

      const deal = await botApi.findDealByCode(raw);

      if (!deal) {
        ctx.session.codeTries = (ctx.session.codeTries || 0) + 1;
        if (ctx.session.codeTries >= 3) {
          await ctx.replyWithHTML(
            'Kod 3 marta noto‘g‘ri kiritildi. Sotuvchidan kodni qayta so‘rang yoki qaytadan urining:',
            codeRetryButton()
          );
          return ctx.scene.leave();
        }
        await ctx.reply(
          `❌ Bunday kod topilmadi yoki bitim yopilgan. Qaytadan kiriting (${3 - ctx.session.codeTries} urinish qoldi):`
        );
        return;
      }

      const isOwnDeal = String((deal.sellerId as any)._id || deal.sellerId) === String(user._id);
      if (isOwnDeal && !config.allowSelfPurchase) {
        await ctx.reply('Bu sizning o‘z bitimingiz — uni sotib ololmaysiz.', mainMenuKeyboard);
        return ctx.scene.leave();
      }
      if (isOwnDeal) {
        await ctx.replyWithHTML(
          '🧪 <b>Sinov rejimi</b> — bu o‘z bitimingiz. Odatda bunga ruxsat berilmaydi.'
        );
      }

      const seller = deal.sellerId as any;
      const rating = seller?.sellerStats?.ratingCount
        ? `⭐ ${(seller.sellerStats.ratingSum / seller.sellerStats.ratingCount).toFixed(1)}`
        : 'yangi sotuvchi';

      await ctx.replyWithHTML(
        [
          `<b>🤝 Bitim topildi</b>`,
          '',
          `<b>${escapeHtml(deal.title)}</b>`,
          `Summa: <b>${formatUzs(deal.price)}</b>`,
          `Sotuvchi: @${escapeHtml(seller?.username || 'noma’lum')} (${rating})`,
          '',
          `<b>🛡 Bitmax kafil bo‘ladi:</b>`,
          `• Pulingiz sotuvchiga darhol o‘tmaydi`,
          `• Avval akkauntni tekshirasiz`,
          `• Muammo bo‘lsa — pul qaytariladi`,
          '',
          describeRefundPolicy(),
        ].join('\n'),
        dealBuyButtons(String(deal._id))
      );

      return ctx.scene.leave();
    }
  );
}

buyerHandler.action('code_retry', async (ctx) => {
  await ctx.answerCbQuery();
  await (ctx as any).scene?.enter(CODE_WIZARD);
});

/**
 * Telegram callback_data is attacker-controllable — a crafted client can send arbitrary
 * callback_query data, not just what was on the button it was shown. Every handler that acts
 * on an escrowId from callback_data MUST verify the clicking user owns it before touching
 * money or releasing credentials.
 */
async function loadOwnedEscrow(telegramId: number, escrowId: string) {
  const user = await User.findOne({ telegramId });
  if (!user) return { error: 'Foydalanuvchi topilmadi' as const };
  if (user.isBlocked) return { error: 'Hisobingiz bloklangan' as const };

  const escrow = await EscrowHold.findById(escrowId).catch(() => null);
  if (!escrow) return { error: 'Buyurtma topilmadi' as const };

  if (escrow.buyerId.toString() !== user._id.toString()) {
    return { error: 'Ruxsat yo‘q' as const };
  }

  return { escrow, user };
}

buyerHandler.hears(["🛍 Akkaunt sotib olish","Akkaunt sotib olish","🛍 Mahsulotlar","Mahsulotlar"], async (ctx) => sendCatalogPage(ctx, 1));

// Real pagination — the old "/next" command only repeated the total count and never actually
// paged. It's kept as an alias so anyone used to typing it still gets somewhere useful.
buyerHandler.command('next', async (ctx) => sendCatalogPage(ctx, 1));

buyerHandler.action(/^catalog_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  await sendCatalogPage(ctx, page, true);
});

buyerHandler.action(/^buy_(.+)$/, async (ctx) => {
  try {
    const productId = ctx.match[1];
    const user = await User.findOne({ telegramId: ctx.from!.id });

    if (!user) {
      await ctx.answerCbQuery('Foydalanuvchi topilmadi — /start bosing');
      return;
    }
    if (user.isBlocked) {
      await ctx.answerCbQuery('Hisobingiz bloklangan');
      return;
    }

    await ctx.answerCbQuery('To‘lov tayyorlanmoqda…');
    const { product, uniqueAmount, card, expiresAt } = await botApi.initiatePurchase(
      productId,
      user._id.toString()
    );

    // The full number, not the masked one: this is the platform's own receiving card and the
    // buyer cannot make the transfer without it. Masking it here (as an earlier version did)
    // left the payment step impossible to complete.
    const cardBlock = card
      ? [
          `<b>💳 Karta:</b> <code>${formatCardNumber(card.raw)}</code>`,
          card.holder ? `<b>👤 Egasi:</b> ${escapeHtml(card.holder)}` : '',
          card.bank ? `<b>🏦 Bank:</b> ${escapeHtml(card.bank)}` : '',
        ].filter(Boolean).join('\n')
      : `<i>⚠️ To‘lov kartasi sozlanmagan — admin bilan bog‘laning.</i>`;

    const paymentMessage = [
      `<b>💳 To‘lov ma’lumotlari</b>`,
      '',
      `<b>Mahsulot:</b> ${escapeHtml(product.title)}`,
      `<b>Narx:</b> ${formatUzs(product.price)}`,
      '',
      `<b>📌 AYNAN shu summani o‘tkazing:</b>`,
      `<code>${uniqueAmount}</code> UZS`,
      '',
      cardBlock,
      '',
      `⏱ <b>Muddat:</b> ${formatDeadline(expiresAt)} gacha (${config.paymentWindowMinutes} daqiqa)`,
      '',
      `<i>⚠️ Summadagi oxirgi raqamlar aynan sizning buyurtmangizni aniqlaydi. ` +
        `Boshqa summa o‘tkazsangiz, to‘lov avtomatik tanilmaydi.</i>`,
      '',
      `<i>Vaqt tugasa, bandlik avtomatik bekor bo‘ladi va sizga xabar beramiz — pulingiz xavfsiz, ` +
        `hech qanday to‘lov so‘ramaymiz.</i>`,
      '',
      `<i>To‘lov tushgach, bot sizga avtomatik xabar yuboradi.</i>`,
    ].join('\n');

    await ctx.editMessageText(paymentMessage, { parse_mode: 'HTML' });
  } catch (error: any) {
    await ctx.reply(describeError(error));
  }
});

buyerHandler.action(/^payment_status_([a-f0-9]{24})$/, async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id, isBlocked: { $ne: true } });
  if (!user) { await ctx.answerCbQuery('Ruxsat yo‘q'); return; }
  const t = await Transaction.findOne({ _id: ctx.match[1], buyerId: user._id });
  if (!t) { await ctx.answerCbQuery('Buyurtma topilmadi'); return; }
  if (t.status === 'paid' || t.status === 'completed') {
    const hold = await EscrowHold.findOne({ transactionId: t._id });
    await ctx.answerCbQuery('To‘lov tasdiqlangan');
    if (hold) await ctx.replyWithHTML('✅ To‘lov tasdiqlandi. Buyurtmangiz:', revealButton(String(hold._id)));
  } else {
    await ctx.answerCbQuery(t.paymentReview ? 'To‘lov qo‘lda tekshirilmoqda' : t.status === 'pending_payment' ? 'To‘lov kutilmoqda — avtomatik tekshiriladi' : 'Buyurtma yopilgan');
  }
});

buyerHandler.action(/^detail_([a-f0-9]{24})(?:_(\d+))?$/, async ctx => {
  await ctx.answerCbQuery();
  const found = await sendProductDetail(ctx, ctx.match[1], Number(ctx.match[2] || 1), true);
  if (!found) await ctx.reply('E’lon topilmadi yoki katalogdan olib tashlangan.');
});
buyerHandler.action(/^description_([a-f0-9]{24})$/, async ctx => {
  const p = await Product.findOne({ _id: ctx.match[1], listingType: 'public', status: { $in: ['active', 'reserved', 'sold'] } }).select('description');
  await ctx.answerCbQuery();
  if (p) await ctx.reply(p.description);
});

/**
 * Reveals the credentials and starts the (24h) confirm-or-auto-release clock.
 *
 * In v1 the only way to see the login was to press "Tasdiqlayman" — which simultaneously
 * released the money to the seller. A buyer could not inspect what they bought before paying
 * out for it, which made the escrow guarantee meaningless. Reveal and confirm are now separate
 * steps: look first, decide second.
 *
 * This is deliberately a *different* clock from the one already running since payment
 * (`unrevealedGraceHours`, shown at payment-confirmed time) — conflating the two in earlier
 * copy was a real source of confusion, so this screen calls out explicitly that a new, shorter
 * timer starts now.
 */
buyerHandler.action(/^reveal_(.+)$/, async (ctx) => {
  try {
    const escrowId = ctx.match[1];
    const owned = await loadOwnedEscrow(ctx.from!.id, escrowId);
    if ('error' in owned) {
      await ctx.answerCbQuery(owned.error);
      return;
    }

    const { credentials, hold, firstReveal } = await paymentService.revealCredentials(
      escrowId,
      owned.user._id.toString()
    );
    const product = await Product.findById(hold.productId);

    const lines = [
      `🔑 <b>Akkaunt ma’lumotlari</b>`,
      '',
      `<b>${escapeHtml(product?.title || 'Mahsulot')}</b>`,
      '',
      `<b>Login:</b> <code>${escapeHtml(credentials.login)}</code>`,
      `<b>Parol:</b> <code>${escapeHtml(credentials.password)}</code>`,
    ];
    if (credentials.recoveryCode) {
      lines.push(`<b>Tiklash kodi:</b> <code>${escapeHtml(credentials.recoveryCode)}</code>`);
    }
    if (credentials.additionalInfo) {
      lines.push(`<b>Qo‘shimcha:</b> ${escapeHtml(credentials.additionalInfo)}`);
    }

    lines.push(
      '',
      `⚠️ <b>MUHIM — tartib bilan bajaring:</b>`,
      `1️⃣ Avval akkauntga <b>kiring va tekshiring</b> (hech narsani o‘zgartirmang)`,
      `2️⃣ Hammasi joyida bo‘lsa — <b>“Tasdiqlayman”</b> tugmasini bosing`,
      `3️⃣ Faqat shundan keyin parol/emailni o‘zingizga o‘zgartiring`,
      '',
      `<i>Agar tasdiqlashdan oldin ma’lumotlarni o‘zgartirsangiz va keyin qaytarish so‘rasangiz, ` +
        `sotuvchi dalil taqdim etib nizoni yutib olishi mumkin.</i>`,
      '',
      `⏱ <b>Yangi muddat shu daqiqadan boshlandi</b> (avvalgi kutish muddatidan farqli):`,
      describeRefundPolicy(),
      '',
      `<i>${formatDeadline(hold.autoReleaseAt)} gacha javob bermasangiz, pul avtomatik ` +
        `sotuvchiga o‘tadi.</i>`
    );

    await ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: escrowActionButtons(escrowId).reply_markup,
    });
    await ctx.answerCbQuery(firstReveal ? '🔑 Ochildi — vaqt boshlandi' : '🔑 Qayta ko‘rsatildi');

    if (firstReveal) {
      const seller = await User.findById(hold.sellerId);
      if (seller?.telegramId) {
        await notificationService.notifySeller(
          seller.telegramId,
          `👀 <b>Xaridor ma’lumotlarni ochdi</b>\n\n` +
            `Mahsulot: ${escapeHtml(product?.title || '—')}\n` +
            `${formatDeadline(hold.autoReleaseAt)} gacha e’tiroz bo‘lmasa, ` +
            `<b>${formatUzs(hold.sellerPayout)}</b> balansingizga o‘tadi.`
        );
      }
    }
  } catch (error: any) {
    await ctx.answerCbQuery(describeError(error));
  }
});

/**
 * Entry point for a deal the buyer already agreed to off-platform: they type the seller's
 * code and go straight to payment. Nothing about the deal is discoverable without the code.
 */
buyerHandler.hears(["🔑 Kod bilan sotib olish","Kod bilan sotib olish","/kod"], async (ctx) => {
  await (ctx as any).scene?.enter(CODE_WIZARD);
});

buyerHandler.action('deal_abort', async (ctx) => {
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('Bitim ochilmadi. Kod hali ham amal qiladi.', { parse_mode: 'HTML' });
});

/**
 * "My orders" — previously only listed EscrowHolds, so a buyer whose payment window expired or
 * whose SMS went unmatched had nothing here to explain what happened to their money. Recent
 * non-escrow transaction states are now folded in as a paper trail alongside the notifications
 * `scheduler.ts` and the SMS webhook now send for those same events.
 */
buyerHandler.hears(["📦 Mening buyurtmalarim","Mening buyurtmalarim","📦 Buyurtmalarim","Buyurtmalarim"], async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user) return;

  const [escrows, otherTransactions] = await Promise.all([
    botApi.getEscrowHolds(user._id.toString(), 'buyer'),
    Transaction.find({
      buyerId: user._id,
      status: { $in: ['pending_payment', 'expired'] },
    })
      .sort('-createdAt')
      .limit(10)
      .populate('productId', 'title'),
  ]);

  if (escrows.length === 0 && otherTransactions.length === 0) {
    await ctx.reply('Sizda hali buyurtmalar mavjud emas.');
    return;
  }

  for (const escrow of escrows) {
    const product = escrow.productId as any;
    const statusLabel: Record<string, string> = {
      holding: '🟡 Escrow’da',
      released: '✅ Yakunlangan',
      refunded: '🔄 Qaytarilgan',
      partial_refunded: '🔄 Qisman qaytarilgan',
      disputed: '⚖️ Nizoda',
    };

    const msg = [
      `${statusLabel[escrow.status] || escrow.status} <b>${escapeHtml(product?.title || 'Mahsulot')}</b>`,
      '',
      `💰 ${formatUzs(escrow.amount)}`,
      `🕐 ${new Date(escrow.boughtAt).toLocaleString('uz-UZ')}`,
      escrow.credentialsRevealedAt
        ? `🔑 Ochilgan: ${new Date(escrow.credentialsRevealedAt).toLocaleString('uz-UZ')}`
        : `🔒 Ma’lumotlar hali ochilmagan`,
    ].join('\n');

    if (escrow.status === 'holding') {
      const keyboard = escrow.credentialsRevealedAt
        ? escrowActionButtons(escrow._id.toString())
        : revealButton(escrow._id.toString());
      await ctx.replyWithHTML(msg, keyboard);
    } else {
      await ctx.replyWithHTML(msg);
    }
  }

  for (const t of otherTransactions) {
    const product = t.productId as any;
    const label = t.status === 'pending_payment' ? '⏳ To‘lov kutilmoqda' : '⌛ Muddati o‘tgan';
    await ctx.replyWithHTML(
      [
        `${label} <b>${escapeHtml(product?.title || 'Mahsulot')}</b>`,
        '',
        `💰 ${formatUzs(t.uniqueAmount)}`,
        ...(t.status === 'pending_payment' && t.paymentCard ? [`💳 <code>${formatCardNumber(t.paymentCard)}</code>`] : []),
        `🕐 ${new Date(t.createdAt).toLocaleString('uz-UZ')}`,
        t.status === 'expired'
          ? `<i>Vaqt tugagani uchun bandlik bekor qilindi. Pulingiz o‘tkazilmagan bo‘lsa xavfsiz.</i>`
          : `<i>Ko‘rsatilgan summani o‘tkazing — tasdiqlangach xabar keladi.</i>`,
      ].join('\n'),
      t.status === 'pending_payment' ? { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Holatni tekshirish', callback_data: `payment_status_${t._id}` }],
      ] } } : undefined
    );
  }
});

buyerHandler.action(/^confirm_escrow_(.+)$/, async (ctx) => {
  try {
    const escrowId = ctx.match[1];
    const owned = await loadOwnedEscrow(ctx.from!.id, escrowId);
    if ('error' in owned) {
      await ctx.answerCbQuery(owned.error);
      return;
    }

    const result = await paymentService.confirmAndRelease(escrowId, owned.user._id.toString());

    const escrow = await EscrowHold.findById(escrowId).populate('sellerId');
    const product = await Product.findById(escrow?.productId);
    const seller = escrow?.sellerId as any;

    if (seller?.telegramId) {
      await notificationService.notifySeller(
        seller.telegramId,
        `✅ <b>Xaridor bitimni tasdiqladi!</b>\n\n` +
          `Mahsulot: ${escapeHtml(product?.title || '—')}\n` +
          `Balansingizga: <b>${formatUzs(result.sellerPayout)}</b>\n` +
          `Komissiya (${config.platformCommission}%): ${formatUzs(result.commission)}`
      );
    }

    await ctx.editMessageText(
      [
        `✅ <b>Bitim yakunlandi!</b>`,
        '',
        `${escapeHtml(product?.title || 'Mahsulot')} bo‘yicha pul sotuvchiga o‘tkazildi.`,
        '',
        `⚠️ Endi akkaunt parolini, emailini va tiklash ma’lumotlarini <b>darhol</b> o‘zingizga o‘zgartiring!`,
        '',
        `<i>Sotuvchini baholang — bu boshqa xaridorlarga yordam beradi.</i>`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [1, 2, 3, 4, 5].map((n) => ({
              text: '⭐'.repeat(n),
              callback_data: `rate_${escrowId}_${n}`,
            })),
          ],
        },
      }
    );
    await ctx.answerCbQuery('✅ Tasdiqlandi!');
  } catch (error: any) {
    await ctx.answerCbQuery(describeError(error));
  }
});

buyerHandler.action(/^rate_(.+)_([1-5])$/, async (ctx) => {
  try {
    const escrowId = ctx.match[1];
    const rating = parseInt(ctx.match[2], 10);

    const owned = await loadOwnedEscrow(ctx.from!.id, escrowId);
    if ('error' in owned) {
      await ctx.answerCbQuery(owned.error);
      return;
    }
    // Conditional update: two quick taps cannot count twice, and an open order cannot be rated.
    const claimed = await EscrowHold.findOneAndUpdate(
      { _id: escrowId, buyerRating: { $exists: false }, status: { $in: ['released', 'refunded', 'partial_refunded'] } },
      { $set: { buyerRating: rating } }
    );
    if (!claimed) {
      await ctx.answerCbQuery('Baho faqat yakunlangan bitimga bir marta beriladi');
      return;
    }

    await User.findByIdAndUpdate(owned.escrow.sellerId, {
      $inc: { 'sellerStats.ratingSum': rating, 'sellerStats.ratingCount': 1 },
    });

    await ctx.editMessageReplyMarkup(undefined);
    await ctx.answerCbQuery(`Rahmat! Bahoyingiz: ${'⭐'.repeat(rating)}`);
  } catch (error: any) {
    await ctx.answerCbQuery(describeError(error));
  }
});

buyerHandler.action(/^refund_escrow_(.+)$/, async (ctx) => {
  const escrowId = ctx.match[1];
  const owned = await loadOwnedEscrow(ctx.from!.id, escrowId);
  if ('error' in owned) {
    await ctx.answerCbQuery(owned.error);
    return;
  }

  // Show the buyer exactly what they will receive before they commit to anything.
  const quote = await paymentService.quoteRefundFor(escrowId);

  if (!quote.allowed) {
    await ctx.editMessageText(
      `❌ <b>Avtomatik qaytarish mumkin emas</b>\n\n${quote.message}\n\n` +
        `Nizo ochish uchun: ${botApi.supportLink()}`,
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
    return;
  }

  await ctx.editMessageText(
    [
      `<b>🔄 Qaytarish hisob-kitobi</b>`,
      '',
      `<b>Davr:</b> ${quote.label} (${quote.elapsedMinutes} daqiqa o‘tdi)`,
      `<b>Jarima:</b> ${quote.penaltyPercent}% — ${formatUzs(quote.penaltyAmount)}`,
      `<b>Sizga qaytariladi:</b> <b>${formatUzs(quote.refundToBuyer)}</b>`,
      '',
      // Previously promised manual review here while still executing the refund automatically
      // below (rdo_*) — that mismatch is fixed by describing the actual behavior instead of a
      // review step that never happens.
      quote.requiresArbitration
        ? `⚠️ <i>Sizda so‘nggi 30 kunda ko‘p qaytarish qayd etilgan. Bu so‘rov ham hisobga ` +
          `olinadi va profilingiz keyingi tekshiruvlarda ko‘rib chiqiladi.</i>`
        : `<i>Sababni tanlang:</i>`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: refundReasonButtons(escrowId).reply_markup }
  );
  await ctx.answerCbQuery();
});

buyerHandler.action(/^rr_(not_working|wrong_info|recovered|other)_(.+)$/, async (ctx) => {
  const reasonType = ctx.match[1];
  const escrowId = ctx.match[2];

  const reasonMap: Record<string, string> = {
    not_working: 'Akkaunt ishlamayapti (login/parol noto‘g‘ri)',
    wrong_info: 'E’londagi ma’lumot haqiqatga mos emas',
    recovered: 'Asl egasi akkauntni qaytarib oldi',
    other: 'Boshqa sabab',
  };

  await ctx.editMessageText(
    `<b>🔄 Tasdiqlash</b>\n\nSabab: <b>${reasonMap[reasonType]}</b>\n\n` +
      `<i>Qaytarishni yakuniy tasdiqlaysizmi? Bu amalni bekor qilib bo‘lmaydi.</i>`,
    { parse_mode: 'HTML', reply_markup: refundConfirmButtons(escrowId, reasonType).reply_markup }
  );
  await ctx.answerCbQuery();
});

buyerHandler.action(/^rdo_(not_working|wrong_info|recovered|other)_(.+)$/, async (ctx) => {
  try {
    const reasonType = ctx.match[1];
    const escrowId = ctx.match[2];

    const reasonMap: Record<string, string> = {
      not_working: 'Akkaunt ishlamayapti (login/parol noto‘g‘ri)',
      wrong_info: 'E’londagi ma’lumot haqiqatga mos emas',
      recovered: 'Asl egasi akkauntni qaytarib oldi',
      other: 'Boshqa sabab',
    };
    const reason = reasonMap[reasonType] || 'Boshqa sabab';

    const owned = await loadOwnedEscrow(ctx.from!.id, escrowId);
    if ('error' in owned) {
      await ctx.answerCbQuery(owned.error);
      return;
    }

    const escrow = await EscrowHold.findById(escrowId)
      .populate('buyerId')
      .populate('sellerId')
      .populate('productId');
    if (!escrow) {
      await ctx.answerCbQuery('Buyurtma topilmadi');
      return;
    }

    const result = await paymentService.processRefund(escrowId, reason, owned.user._id.toString());

    if (!result.allowed) {
      await ctx.editMessageText(`❌ <b>Qaytarish mumkin emas</b>\n\n${result.message}`, {
        parse_mode: 'HTML',
      });
      await ctx.answerCbQuery();
      return;
    }

    await ctx.editMessageText(
      [
        `🔄 <b>Qaytarish bajarildi</b>`,
        '',
        `<b>Sabab:</b> ${reason}`,
        `<b>Jarima:</b> ${formatUzs(result.penaltyAmount ?? 0)}`,
        `<b>Balansingizga qaytarildi:</b> <b>${formatUzs(result.refundToBuyer ?? 0)}</b>`,
        '',
        `<i>Pulni kartangizga yechish uchun “Balans” → “Pul yechish”.</i>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery('Qaytarildi');

    const product = escrow.productId as any;
    const buyer = escrow.buyerId as any;
    const seller = escrow.sellerId as any;

    await notificationService.notifyRefundToAdmin({
      buyer: `@${buyer.username || buyer.telegramId}`,
      seller: `@${seller.username || seller.telegramId}`,
      productTitle: product?.title || '—',
      amount: escrow.amount,
      reason,
      quote: result.quote,
      escrowId,
      sellerId: String(seller._id),
      productId: String(product?._id),
    });

    if (seller?.telegramId) {
      await notificationService.notifySeller(
        seller.telegramId,
        [
          `🔄 <b>Xaridor qaytarish so‘radi</b>`,
          '',
          `Mahsulot: ${escapeHtml(product?.title || '—')}`,
          `Sabab: ${reason}`,
          `Sizga kompensatsiya: <b>${formatUzs(result.sellerKeeps ?? 0)}</b>`,
          '',
          `<i>Agar xaridor akkauntni o‘zlashtirib olib qaytargan bo‘lsa — dalil bilan ` +
            `nizo oching: ${botApi.supportLink()}</i>`,
        ].join('\n')
      );
    }
  } catch (error: any) {
    await ctx.answerCbQuery(describeError(error));
  }
});

buyerHandler.action(/^refund_cancel_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.reply('Qaytarish jarayoni bekor qilindi.', mainMenuKeyboard);
});

buyerHandler.action(/^help_escrow_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    [
      `<b>❓ Escrow qanday ishlaydi</b>`,
      '',
      `<b>✅ Tasdiqlayman</b> — akkaunt joyida, pul sotuvchiga o‘tadi.`,
      `<b>🔄 Qaytarish</b> — muammo bo‘lsa, siyosat bo‘yicha pul qaytariladi.`,
      '',
      `<b>Qaytarish shartlari</b> (ma’lumotlarni ochgan vaqtdan hisoblanadi):`,
      describeRefundPolicy(),
      '',
      `<i>Vaqt to‘lov emas, ma’lumotlarni ochgan daqiqadan boshlanadi — ` +
        `to‘lov siz uxlab yotganingizda tasdiqlanishi mumkin.</i>`,
    ].join('\n')
  );
});
