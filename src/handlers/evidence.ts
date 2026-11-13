import { Composer, Scenes } from 'telegraf';
import mongoose from 'mongoose';
import { config } from '../config';
import { Dispute } from '../models/Dispute';
import { User } from '../models/User';
import { addEvidence, EvidenceInput, MAX_EVIDENCE } from '../services/disputeService';
import { notificationService } from '../services/notificationService';
import { escapeHtml, formatUzs } from '../utils/helpers';
import { describeError } from '../utils/errors';
import { bailIfCancelled } from '../wizards/guard';
import { mainMenuKeyboard } from '../keyboards';

/**
 * Dispute evidence, collected in the chat where the dispute was opened.
 *
 * Both sides press "📎 Dalil yuborish" and send screenshots, videos, files or a written
 * account. Each piece is stored on the dispute (Telegram's file_id, so the admin can open it
 * again later) and copied to the admin chat at once.
 */

export const EVIDENCE_SCENE = 'dispute_evidence';

const doneButton = { reply_markup: { inline_keyboard: [[{ text: '✅ Tayyor', callback_data: 'dsp_ev_done' }]] } };

/** What the message carries, in the shape the dispute stores. Null for anything unsupported. */
function evidenceFrom(message: any): EvidenceInput | null {
  if (!message) return null;
  const note = message.caption || undefined;
  if (message.photo?.length) return { kind: 'photo', ref: message.photo[message.photo.length - 1].file_id, note };
  if (message.video) return { kind: 'video', ref: message.video.file_id, note };
  if (message.document) return { kind: 'file', ref: message.document.file_id, note };
  if (message.voice) return { kind: 'file', ref: message.voice.file_id, note };
  if (typeof message.text === 'string' && !message.text.startsWith('/')) return { kind: 'text', note: message.text };
  return null;
}

export function createEvidenceScene() {
  const scene = new Scenes.BaseScene<any>(EVIDENCE_SCENE);

  scene.enter(async (ctx: any) => {
    await ctx.replyWithHTML(
      `📎 <b>Dalil yuborish</b>\n\nSkrinshot, video, fayl yoki yozma izoh yuboring — bir nechtasini ketma-ket ` +
        `yuborishingiz mumkin (jami ${MAX_EVIDENCE} tagacha). Hammasi adminga yetkaziladi.\n\nTugatgach “✅ Tayyor” ni bosing.`,
      doneButton
    );
  });

  scene.action('dsp_ev_done', async (ctx: any) => {
    await ctx.answerCbQuery('Rahmat');
    await ctx.reply('✅ Dalillar qabul qilindi. Admin qaror qilgach natija shu yerga keladi.', mainMenuKeyboard);
    await ctx.scene.leave();
  });

  scene.on('message', async (ctx: any) => {
    if (await bailIfCancelled(ctx)) return;

    const input = evidenceFrom(ctx.message);
    if (!input) {
      await ctx.reply('Bu turdagi xabarni qabul qila olmayman — rasm, video, fayl yoki matn yuboring.', doneButton);
      return;
    }

    const disputeId = ctx.scene.state?.disputeId;
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!disputeId || !user) {
      await ctx.reply('Nizo topilmadi.', mainMenuKeyboard);
      return ctx.scene.leave();
    }

    let dispute;
    try {
      dispute = await addEvidence(disputeId, String(user._id), input);
    } catch (error) {
      await ctx.reply(describeError(error), mainMenuKeyboard);
      return ctx.scene.leave();
    }

    const side = String(dispute.buyerId) === String(user._id) ? 'Xaridor' : 'Sotuvchi';
    const who = user.username ? '@' + escapeHtml(user.username) : String(user.telegramId);
    await notificationService.notifyAdmin(
      `📎 <b>Nizoga dalil</b> (${dispute.evidence.length}/${MAX_EVIDENCE})\n` +
        `${side}: ${who} · Summa: ${formatUzs(dispute.amount)}\nNizo: <code>${dispute._id}</code>`
    );
    // The original goes to the admin as it is; a failure here never loses it (it is stored).
    if (config.adminChatId) {
      await ctx.telegram.copyMessage(config.adminChatId, ctx.chat.id, ctx.message.message_id).catch(() => undefined);
    }
    await ctx.reply(`Qabul qilindi (${dispute.evidence.length}/${MAX_EVIDENCE}). Yana yuboring yoki “✅ Tayyor” ni bosing.`, doneButton);
  });

  return scene;
}

export const evidenceHandler = new Composer<any>();

/** Entry from the "📎 Dalil yuborish" button on the dispute messages. */
evidenceHandler.action(/^dsp_ev_([a-f0-9]{24})$/, async (ctx: any) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const dispute = user && (await Dispute.findById(ctx.match[1]));
  const party = dispute && [String(dispute.buyerId), String(dispute.sellerId)].includes(String(user!._id));
  if (!party) return void ctx.answerCbQuery('Ruxsat yo‘q');
  if (!['open', 'under_review'].includes(dispute!.status)) return void ctx.answerCbQuery('Bu nizo yopilgan', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.scene.enter(EVIDENCE_SCENE, { disputeId: String(dispute!._id) });
});

/** The admin side: every piece of evidence, re-sent from Telegram's stored file ids. */
export async function sendEvidenceTo(ctx: any, disputeId: string) {
  if (!mongoose.isValidObjectId(disputeId)) return 0;
  const dispute = await Dispute.findById(disputeId).populate('buyerId', '_id');
  if (!dispute) return 0;
  for (const [index, item] of dispute.evidence.entries()) {
    const side = String((dispute.buyerId as any)?._id || dispute.buyerId) === String(item.addedBy) ? 'Xaridor' : 'Sotuvchi';
    const caption = `${index + 1}. ${side}${item.note ? ': ' + item.note : ''}`.slice(0, 1000);
    try {
      if (item.kind === 'photo') await ctx.replyWithPhoto(item.ref, { caption });
      else if (item.kind === 'video') await ctx.replyWithVideo(item.ref, { caption });
      else if (item.kind === 'file') await ctx.replyWithDocument(item.ref, { caption });
      else await ctx.reply(caption);
    } catch {
      await ctx.reply(`${index + 1}. ${side}: faylni ochib bo‘lmadi`);
    }
  }
  return dispute.evidence.length;
}
