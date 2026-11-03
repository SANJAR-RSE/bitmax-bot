import { Composer, Scenes } from 'telegraf';
import mongoose from 'mongoose';
import { User, IUser } from '../models/User';
import { Product } from '../models/Product';
import { EscrowHold } from '../models/EscrowHold';
import { Transaction } from '../models/Transaction';
import { PaymentInbox } from '../models/PaymentInbox';
import { Payout } from '../models/Payout';
import { Dispute } from '../models/Dispute';
import { audit } from '../models/AuditLog';
import { notificationService } from '../services/notificationService';
import { payoutService } from '../services/payoutService';
import { ledgerService, accounts } from '../services/ledgerService';
import { adminMenuKeyboard, moderationButtons, payoutButtons } from '../keyboards';
import { config, isAdminTelegramId } from '../config';
import { escapeHtml, formatUzs } from '../utils/helpers';
import { bailIfCancelled } from '../wizards/guard';

export const adminHandler = new Composer();

/** Resolves the acting admin, or null when the caller isn't one. */
async function requireAdmin(ctx: any) {
  const telegramId = ctx.from?.id;
  if (!telegramId || !isAdminTelegramId(telegramId)) return null;
  return User.findOne({ telegramId });
}

adminHandler.use(async (ctx, next) => {
  const telegramId = ctx.from?.id;
  if (telegramId && isAdminTelegramId(telegramId)) {
    await User.updateOne({ telegramId, role: { $ne: 'admin' } }, { $set: { role: 'admin' } });
  }
  return next();
});

adminHandler.hears(["👥 Foydalanuvchilar","Foydalanuvchilar"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const [total, buyers, sellers, blocked, flagged] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ role: 'buyer' }),
    User.countDocuments({ role: 'seller' }),
    User.countDocuments({ isBlocked: true }),
    User.countDocuments({ refundAutoDisabled: true }),
  ]);

  await ctx.replyWithHTML(
    [
      `<b>👥 Foydalanuvchilar</b>`,
      '',
      `Jami: <b>${total}</b>`,
      `Xaridorlar: ${buyers}`,
      `Sotuvchilar: ${sellers}`,
      `Bloklangan: ${blocked}`,
      `Qaytarish cheklangan: ${flagged}`,
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🎚 Rol belgilash', callback_data: 'admin_set_role' }]],
      },
    }
  );
});

// ─── Roles ─────────────────────────────────────────────────────────────────────

export const ROLE_WIZARD = 'admin_set_role';

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findUserByHandle(handle: string): Promise<IUser | null> {
  const query = handle.trim().replace(/^@/, '');
  if (!query) return null;
  if (/^\d+$/.test(query)) return User.findOne({ telegramId: Number(query) });
  return User.findOne({ username: new RegExp(`^${escapeRegex(query)}$`, 'i') });
}

adminHandler.action('admin_set_role', async (ctx) => {
  if (!(await requireAdmin(ctx))) return void ctx.answerCbQuery('Ruxsat yo‘q');
  await ctx.answerCbQuery();
  await (ctx as any).scene?.enter(ROLE_WIZARD);
});

adminHandler.command('setrole', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await (ctx as any).scene?.enter(ROLE_WIZARD);
});

/**
 * Grants or changes a user's role — the piece that was missing: admin was only ever assigned
 * automatically from ADMIN_CHAT_ID / ADMIN_IDS, and there was no way to make someone a
 * moderator, or to hand a user's seller/buyer role back after a mistake, without editing the
 * database by hand.
 *
 * Promoting to 'admin' is restricted to the platform owner specifically — not to every admin —
 * so a moderator or secondary admin can never mint another admin.
 */
export function createRoleWizard() {
  return new Scenes.WizardScene<any>(
    ROLE_WIZARD,
    async (ctx: any) => {
      if (!isAdminTelegramId(ctx.from!.id)) return ctx.scene.leave();
      await ctx.reply(
        'Foydalanuvchini @username yoki Telegram ID orqali kiriting:\n\n' +
          '/cancel — bekor qilish'
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      if (await bailIfCancelled(ctx)) return;

      const raw = String(ctx.message?.text || '').trim();
      if (/^\/cancel$/i.test(raw)) {
        await ctx.reply('Bekor qilindi.', adminMenuKeyboard);
        return ctx.scene.leave();
      }
      if (!raw) {
        await ctx.reply('Iltimos, @username yoki Telegram ID kiriting:');
        return;
      }

      const user = await findUserByHandle(raw);
      if (!user) {
        await ctx.reply('Foydalanuvchi topilmadi. Qaytadan kiriting yoki /cancel:');
        return;
      }

      ctx.wizard.state.targetUserId = String(user._id);
      const isOwner = String(ctx.from!.id) === config.adminChatId;

      const rows = [
        [
          { text: '🛍 Xaridor', callback_data: 'role_buyer' },
          { text: '💼 Sotuvchi', callback_data: 'role_seller' },
        ],
        [{ text: '🛡 Moderator', callback_data: 'role_moderator' }],
      ];
      if (isOwner) rows.push([{ text: '👑 Admin', callback_data: 'role_admin' }]);
      rows.push([{ text: '❌ Bekor qilish', callback_data: 'role_cancel' }]);

      await ctx.replyWithHTML(
        [
          `<b>Foydalanuvchi:</b> @${escapeHtml(user.username || String(user.telegramId))}`,
          `<b>Hozirgi rol:</b> ${user.role}`,
          '',
          `Yangi rolni tanlang:`,
        ].join('\n'),
        { reply_markup: { inline_keyboard: rows } }
      );
      return ctx.wizard.next();
    },

    async (ctx: any) => {
      const data = ctx.callbackQuery?.data;
      if (!data) {
        await ctx.reply('Iltimos, tugmalardan birini tanlang.');
        return;
      }

      if (data === 'role_cancel') {
        await ctx.answerCbQuery('Bekor qilindi');
        await ctx.editMessageText('Bekor qilindi.', { parse_mode: 'HTML' });
        return ctx.scene.leave();
      }

      const match = /^role_(buyer|seller|moderator|admin)$/.exec(data);
      if (!match) {
        await ctx.answerCbQuery();
        return;
      }

      const newRole = match[1] as 'buyer' | 'seller' | 'moderator' | 'admin';
      const isOwner = String(ctx.from!.id) === config.adminChatId;
      if (newRole === 'admin' && !isOwner) {
        await ctx.answerCbQuery('Faqat platforma egasi admin tayinlashi mumkin');
        return;
      }

      const targetId = ctx.wizard.state.targetUserId as string;
      const before = await User.findById(targetId);
      if (!before) {
        await ctx.answerCbQuery('Foydalanuvchi topilmadi');
        return ctx.scene.leave();
      }

      await User.updateOne({ _id: targetId }, { $set: { role: newRole } });

      await audit({
        actorTelegramId: ctx.from!.id,
        action: 'user.role_changed',
        targetType: 'User',
        targetId: new mongoose.Types.ObjectId(targetId),
        before: { role: before.role },
        after: { role: newRole },
      });

      await ctx.answerCbQuery('Yangilandi');
      await ctx.editMessageText(
        `✅ @${escapeHtml(before.username || String(before.telegramId))} roli endi: <b>${newRole}</b>`,
        { parse_mode: 'HTML' }
      );

      if (before.telegramId) {
        await notificationService.send({
          type: 'buyer',
          chatId: before.telegramId,
          message: `ℹ️ Sizning rolingiz o‘zgardi: <b>${newRole}</b>`,
        });
      }

      return ctx.scene.leave();
    }
  );
}

adminHandler.hears(["📊 Statistika","Statistika"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const [
    totalProducts,
    activeProducts,
    pendingReview,
    soldProducts,
    totalTransactions,
    pendingPayments,
    escrowHolding,
    unmatchedInbox,
    pendingPayouts,
    openDisputes,
  ] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ status: 'active' }),
    Product.countDocuments({ status: 'pending_review' }),
    Product.countDocuments({ status: 'sold' }),
    Transaction.countDocuments(),
    Transaction.countDocuments({ status: 'pending_payment' }),
    EscrowHold.countDocuments({ status: 'holding' }),
    PaymentInbox.countDocuments({ status: 'unmatched' }),
    Payout.countDocuments({ status: { $in: ['requested', 'approved', 'processing'] } }),
    Dispute.countDocuments({ status: { $in: ['open', 'under_review'] } }),
  ]);

  // Revenue and float come from the ledger, not from summing documents — the journal is the
  // only place these numbers are guaranteed to be internally consistent.
  const [revenue, escrowFloat] = await Promise.all([
    ledgerService.balanceOf(accounts.platformRevenue),
    (async () => {
      const balances = await ledgerService.allBalances();
      return Object.entries(balances)
        .filter(([account]) => account.startsWith('escrow:'))
        .reduce((sum, [, value]) => sum + value, 0);
    })(),
  ]);

  await ctx.replyWithHTML(
    [
      `<b>📊 Platforma statistikasi</b>`,
      '',
      `<b>💰 Moliya</b>`,
      `Platforma daromadi: <b>${formatUzs(revenue)}</b>`,
      `Escrow’dagi pul: <b>${formatUzs(escrowFloat)}</b>`,
      '',
      `<b>📦 Mahsulotlar</b>`,
      `Jami: ${totalProducts} | Faol: ${activeProducts} | Sotilgan: ${soldProducts}`,
      `Moderatsiyada: <b>${pendingReview}</b>`,
      '',
      `<b>💳 Tranzaksiyalar</b>`,
      `Jami: ${totalTransactions} | Kutilayotgan: ${pendingPayments}`,
      `Escrow’da: ${escrowHolding}`,
      '',
      `<b>⚠️ E’tibor talab qiladi</b>`,
      `Egasi topilmagan to‘lov: <b>${unmatchedInbox}</b>`,
      `Pul yechish so‘rovi: <b>${pendingPayouts}</b>`,
      `Ochiq nizolar: <b>${openDisputes}</b>`,
    ].join('\n')
  );
});

// ─── Moderation ────────────────────────────────────────────────────────────────

adminHandler.hears(["🛡 Moderatsiya","Moderatsiya"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const queue = await Product.find({ status: 'pending_review' })
    .sort('createdAt')
    .limit(10)
    .populate('sellerId', 'telegramId username trustLevel sellerStats');

  if (queue.length === 0) {
    await ctx.reply('✅ Moderatsiya navbati bo‘sh.');
    return;
  }

  for (const product of queue) {
    const seller = product.sellerId as any;

    // Previously moderators approved/rejected blind to any photos the seller attached — the
    // images existed in the database but were never shown here.
    if (product.images?.length > 0) {
      await ctx.replyWithMediaGroup(
        product.images.slice(0, 10).map((url: string, i: number) => ({
          type: 'photo' as const,
          media: url,
          ...(i === 0 ? { caption: escapeHtml(product.title) } : {}),
        }))
      );
    }

    await ctx.replyWithHTML(
      [
        `<b>🛡 Ko‘rikda: ${escapeHtml(product.title)}</b>`,
        '',
        escapeHtml(product.description.slice(0, 500)),
        '',
        `Narx: <b>${formatUzs(product.price)}</b>`,
        `Kategoriya: ${escapeHtml(product.category)}`,
        `Sotuvchi: @${escapeHtml(seller?.username || String(seller?.telegramId))} (${seller?.trustLevel})`,
        `Sotgan: ${seller?.sellerStats?.sold ?? 0} | Qaytarilgan: ${seller?.sellerStats?.refunded ?? 0}`,
      ].join('\n'),
      moderationButtons(String(product._id))
    );
  }
});

adminHandler.action(/^mod_approve_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  const productId = ctx.match[1];
  const product = await Product.findOneAndUpdate(
    { _id: productId, status: 'pending_review' },
    { $set: { status: 'active', moderatedBy: admin._id, moderatedAt: new Date() } },
    { new: true }
  );
  if (!product) return void ctx.answerCbQuery('Topilmadi yoki allaqachon ko‘rilgan');

  await audit({
    actorId: admin._id as any,
    action: 'product.approved',
    targetType: 'Product',
    targetId: product._id as any,
  });

  const seller = await User.findById(product.sellerId);
  await notificationService.notifySeller(
    seller?.telegramId,
    `✅ <b>E’loningiz tasdiqlandi</b>\n\n${escapeHtml(product.title)} — endi katalogda ko‘rinadi.`
  );

  await ctx.editMessageText(`✅ Tasdiqlandi: ${escapeHtml(product.title)}`, { parse_mode: 'HTML' });
  await ctx.answerCbQuery('Tasdiqlandi');
});

adminHandler.action(/^mod_reject_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  const productId = ctx.match[1];
  const product = await Product.findOneAndUpdate(
    { _id: productId, status: 'pending_review' },
    {
      $set: {
        status: 'rejected',
        moderatedBy: admin._id,
        moderatedAt: new Date(),
        moderationNote: 'Moderator rad etdi',
      },
    },
    { new: true }
  );
  if (!product) return void ctx.answerCbQuery('Topilmadi yoki allaqachon ko‘rilgan');

  await audit({
    actorId: admin._id as any,
    action: 'product.rejected',
    targetType: 'Product',
    targetId: product._id as any,
  });

  const seller = await User.findById(product.sellerId);
  await notificationService.notifySeller(
    seller?.telegramId,
    `❌ <b>E’loningiz rad etildi</b>\n\n${escapeHtml(product.title)}\n\n` +
      `Sabab bo‘yicha savollar uchun: https://t.me/${config.supportUsername}`
  );

  await ctx.editMessageText(`❌ Rad etildi: ${escapeHtml(product.title)}`, { parse_mode: 'HTML' });
  await ctx.answerCbQuery('Rad etildi');
});

// ─── Payouts ───────────────────────────────────────────────────────────────────

adminHandler.hears(["💸 To‘lov so‘rovlari","To‘lov so‘rovlari"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const pending = await payoutService.listPending(10);
  if (pending.length === 0) {
    await ctx.reply('✅ Pul yechish so‘rovlari yo‘q.');
    return;
  }

  for (const payout of pending) {
    const user = payout.userId as any;
    await ctx.replyWithHTML(
      [
        `<b>💸 Pul yechish so‘rovi</b>`,
        '',
        `Foydalanuvchi: @${escapeHtml(user?.username || String(user?.telegramId))}`,
        `Summa: <b>${formatUzs(payout.amount)}</b>`,
        `Komissiya: ${formatUzs(payout.fee)}`,
        `O‘tkazish: <b>${formatUzs(payout.netAmount)}</b>`,
        `Karta: <code>${payout.destinationMasked}</code>`,
        `Egasi: ${escapeHtml(payout.destinationHolder || '—')}`,
        `Sana: ${payout.requestedAt.toLocaleString('uz-UZ')}`,
      ].join('\n'),
      payoutButtons(String(payout._id))
    );
  }
});

adminHandler.action(/^po_reveal_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  try {
    const card = await payoutService.revealDestination(ctx.match[1], String(admin._id));
    // Sent as a separate message so it isn't left sitting in an edited queue entry.
    await ctx.reply(`💳 Karta: <code>${card}</code>`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery('Ko‘rsatildi (audit qilindi)');
  } catch (error: any) {
    await ctx.answerCbQuery(error.message);
  }
});

adminHandler.action(/^po_paid_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  try {
    const payout = await payoutService.markPaid(ctx.match[1], String(admin._id));
    const user = await User.findById(payout.userId);
    await notificationService.send({
      type: 'buyer',
      chatId: user?.telegramId,
      message: `✅ <b>Pul yuborildi</b>\n\n${formatUzs(payout.netAmount)} kartangizga o‘tkazildi.`,
    });
    await ctx.editMessageText(`✅ To‘landi: ${formatUzs(payout.netAmount)}`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery('Belgilandi');
  } catch (error: any) {
    await ctx.answerCbQuery(error.message);
  }
});

adminHandler.action(/^po_reject_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  try {
    const payout = await payoutService.reject(ctx.match[1], String(admin._id), 'Admin rad etdi');
    const user = await User.findById(payout.userId);
    await notificationService.send({
      type: 'buyer',
      chatId: user?.telegramId,
      message:
        `❌ <b>Pul yechish rad etildi</b>\n\n${formatUzs(payout.amount)} balansingizga qaytarildi.\n` +
        `Savollar uchun: https://t.me/${config.supportUsername}`,
    });
    await ctx.editMessageText('❌ Rad etildi, pul balansga qaytarildi', { parse_mode: 'HTML' });
    await ctx.answerCbQuery('Rad etildi');
  } catch (error: any) {
    await ctx.answerCbQuery(error.message);
  }
});

// ─── Payment inbox ─────────────────────────────────────────────────────────────

adminHandler.hears(["📥 To‘lov inbox","To‘lov inbox"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const unmatched = await PaymentInbox.find({ status: 'unmatched' }).sort('receivedAt').limit(10);
  if (unmatched.length === 0) {
    await ctx.reply('✅ Barcha to‘lovlar buyurtmalarga bog‘langan.');
    return;
  }

  for (const item of unmatched) {
    await ctx.replyWithHTML([
      '<b>📥 Egasi topilmagan to‘lov</b>',
      `<b>${item.parsedAmount ? formatUzs(item.parsedAmount) : '—'}</b> — ${item.receivedAt.toLocaleString('uz-UZ')}`,
      `<code>${escapeHtml(item.rawText.slice(0, 90))}</code>`, '',
      item.reminderMuted ? '🔕 Takroriy eslatma o‘chirilgan.' : '🔔 Takroriy eslatma yoqilgan.',
      '<i>Eslatmani o‘chirish to‘lovni hal qilingan deb belgilamaydi. Yozuv saqlanadi.</i>',
    ].join('\n'), { reply_markup: { inline_keyboard: [[{
      text: item.reminderMuted ? '🔔 Eslatmani yoqish' : '🔕 Eslatmani to‘xtatish',
      callback_data: `inbox_${item.reminderMuted ? 'unmute' : 'mute'}_${item._id}`,
    }]] } });
  }
});

adminHandler.action(/^inbox_(mute|unmute)_([a-f0-9]{24})$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');
  const muted = ctx.match[1] === 'mute';
  try {
    const item = await PaymentInbox.findOneAndUpdate(
      { _id: ctx.match[2], status: 'unmatched' },
      { $set: { reminderMuted: muted, reminderChangedBy: admin._id, reminderChangedAt: new Date() } },
      { new: true }
    );
    if (!item) return void ctx.answerCbQuery('To‘lov topilmadi yoki allaqachon hal qilingan');
    await ctx.answerCbQuery(muted ? '🔕 Shu to‘lov eslatmasi to‘xtatildi' : '🔔 Shu to‘lov eslatmasi yoqildi');
    // Update only this row: a summary may contain other payments that must keep their controls.
    const markup = (ctx.callbackQuery.message as any)?.reply_markup;
    if (markup?.inline_keyboard) {
      const inline_keyboard = markup.inline_keyboard.map((row: any[]) => row.map(button =>
        button.callback_data === ctx.match[0] ? {
          text: muted ? '🔔 Eslatmani qayta yoqish' : '🔕 Eslatmani to‘xtatish',
          callback_data: `inbox_${muted ? 'unmute' : 'mute'}_${item._id}`,
        } : button
      ));
      await ctx.editMessageReplyMarkup({ inline_keyboard }).catch(() => undefined);
    }
  } catch (error) {
    console.error('[Admin] Could not change payment reminder');
    await ctx.answerCbQuery('Saqlab bo‘lmadi, qayta urinib ko‘ring').catch(() => undefined);
  }
});

// ─── Disputes ──────────────────────────────────────────────────────────────────

adminHandler.hears(["⚖️ Nizolar","Nizolar"], async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const disputes = await Dispute.find({ status: { $in: ['open', 'under_review'] } })
    .sort('slaDueAt')
    .limit(10)
    .populate('buyerId', 'username telegramId')
    .populate('sellerId', 'username telegramId')
    .populate('productId', 'title');

  if (disputes.length === 0) {
    await ctx.reply('✅ Ochiq nizolar yo‘q.');
    return;
  }

  for (const dispute of disputes) {
    const buyer = dispute.buyerId as any;
    const seller = dispute.sellerId as any;
    const product = dispute.productId as any;

    await ctx.replyWithHTML(
      [
        `<b>⚖️ Nizo — ${dispute.category}</b>`,
        '',
        `Mahsulot: ${escapeHtml(product?.title || '—')}`,
        `Summa: <b>${formatUzs(dispute.amount)}</b>`,
        `Xaridor: @${escapeHtml(buyer?.username || String(buyer?.telegramId))}`,
        `Sotuvchi: @${escapeHtml(seller?.username || String(seller?.telegramId))}`,
        `Sabab: ${escapeHtml(dispute.reason)}`,
        `Dalillar: ${dispute.evidence.length} ta`,
        `SLA: ${dispute.slaDueAt.toLocaleString('uz-UZ')}`,
        '',
        `<i>Hal qilish: /dispute_${dispute._id}</i>`,
      ].join('\n')
    );
  }
});

// ─── User actions ──────────────────────────────────────────────────────────────

/**
 * Blocks the seller behind a refund alert. The callback carries the *seller* id directly —
 * v1 packed an escrow id into both `admin_ban_` and `admin_ban_seller_`, and because the
 * shorter pattern was registered first it swallowed the longer one and then looked up
 * "seller_<id>" as an ObjectId, throwing on every use.
 */
adminHandler.action(/^adm_ban_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  const userId = ctx.match[1];
  const target = await User.findByIdAndUpdate(
    userId,
    { $set: { isBlocked: true, blockReason: 'Admin tomonidan bloklandi' } },
    { new: true }
  ).catch(() => null);

  if (!target) return void ctx.answerCbQuery('Foydalanuvchi topilmadi');

  // Pull their listings out of the catalog too, otherwise a blocked scammer's accounts stay buyable.
  await Product.updateMany(
    { sellerId: target._id, status: { $in: ['active', 'pending_review'] } },
    { $set: { status: 'archived' } }
  );

  await audit({
    actorId: admin._id as any,
    action: 'user.blocked',
    targetType: 'User',
    targetId: target._id as any,
  });

  await ctx.answerCbQuery('🚫 Bloklandi');
  await ctx.reply(`🚫 @${target.username || target.telegramId} bloklandi va e’lonlari arxivlandi.`);
});

adminHandler.action(/^adm_delprod_(.+)$/, async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (!admin) return void ctx.answerCbQuery('Ruxsat yo‘q');

  const product = await Product.findByIdAndUpdate(
    ctx.match[1],
    { $set: { status: 'archived' } },
    { new: true }
  ).catch(() => null);

  if (!product) return void ctx.answerCbQuery('Mahsulot topilmadi');

  await audit({
    actorId: admin._id as any,
    action: 'product.archived',
    targetType: 'Product',
    targetId: product._id as any,
  });

  await ctx.answerCbQuery('🗑 Arxivlandi');
  await ctx.reply(`🗑 E’lon arxivlandi: ${escapeHtml(product.title)}`);
});

adminHandler.action(/^adm_details_(.+)$/, async (ctx) => {
  if (!(await requireAdmin(ctx))) return void ctx.answerCbQuery('Ruxsat yo‘q');

  const escrow = await EscrowHold.findById(ctx.match[1])
    .populate('buyerId', 'telegramId username firstName buyerStats')
    .populate('sellerId', 'telegramId username firstName sellerStats trustLevel')
    .populate('productId', 'title price category')
    .catch(() => null);

  if (!escrow) return void ctx.answerCbQuery('Topilmadi');

  const product = escrow.productId as any;
  const buyer = escrow.buyerId as any;
  const seller = escrow.sellerId as any;

  await ctx.reply(
    [
      `<b>📋 Escrow tafsilotlari</b>`,
      '',
      `Mahsulot: ${escapeHtml(product?.title || '—')}`,
      `Summa: ${formatUzs(escrow.amount)}`,
      `Komissiya: ${formatUzs(escrow.commission)}`,
      `Sotuvchi ulushi: ${formatUzs(escrow.sellerPayout)}`,
      '',
      `Xaridor: @${escapeHtml(buyer?.username || String(buyer?.telegramId))} ` +
        `(xarid: ${buyer?.buyerStats?.purchased ?? 0}, qaytargan: ${buyer?.buyerStats?.refunded ?? 0})`,
      `Sotuvchi: @${escapeHtml(seller?.username || String(seller?.telegramId))} (${seller?.trustLevel})`,
      '',
      `Holat: <b>${escrow.status}</b>`,
      `Sotib olingan: ${escrow.boughtAt.toLocaleString('uz-UZ')}`,
      `Ma’lumot ochilgan: ${escrow.credentialsRevealedAt?.toLocaleString('uz-UZ') || 'ochilmagan'}`,
      `Ko‘rish soni: ${escrow.credentialRevealCount}`,
      `Sabab: ${escapeHtml(escrow.refundReason || '—')}`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery();
});

adminHandler.action('admin_menu', async (ctx) => {
  if (!(await requireAdmin(ctx))) return void ctx.answerCbQuery('Ruxsat yo‘q');
  await ctx.reply('Admin menyusi', adminMenuKeyboard);
  await ctx.answerCbQuery();
});
