import { Product } from '../models/Product';
import { botApi } from '../services/botApi';
import { config } from '../config';
import { escapeHtml, formatUzs } from '../utils/helpers';
import { parseListingCode } from '../utils/listingCode';

export function catalogKeyboard(products: { _id: any; title: string; price: number }[], page: number, pages: number) {
  const rows: any[][] = [[{ text: '🌐 Saytda katalogni ochish', url: `${config.siteUrl.replace(/\/$/, '')}/katalog` }]];
  for (const p of products) rows.push([{ text: `${Array.from(p.title.replace(/\s+/g, ' ')).slice(0, 38).join('')}${p.title.length > 38 ? '…' : ''} · ${formatUzs(p.price)}`, callback_data: `detail_${p._id}_${page}` }]);
  const pager = [];
  if (page > 1) pager.push({ text: '← Oldingi', callback_data: `catalog_page_${page - 1}` });
  if (page < pages) pager.push({ text: 'Keyingi →', callback_data: `catalog_page_${page + 1}` });
  if (pager.length) rows.push(pager);
  return { inline_keyboard: rows };
}

export async function sendCatalogPage(ctx: any, requestedPage: number, edit = false) {
  const { products, total, pages, page } = await botApi.getActiveProducts(requestedPage, 10);
  const text = `<b>Akkauntlar katalogi</b>\n${total} ta e’lon · ${page}/${pages}-sahifa\n\n` +
    (total ? 'Nom va narx bo‘yicha tanlang. Batafsil ma’lumot uchun e’lonni bosing.\n\nE’lon ID’sini ham shu chatga yuborishingiz mumkin.' : 'Hozircha sotuvda akkaunt yo‘q. Yangi e’lonlar shu yerda chiqadi.');
  const options = { parse_mode: 'HTML' as const, reply_markup: catalogKeyboard(products, page, pages), link_preview_options: { is_disabled: true } };
  if (edit) {
    try { await ctx.editMessageText(text, options); } catch (error: any) {
      if (!String(error?.description).includes('message is not modified')) throw error;
    }
  } else await ctx.reply(text, options);
}

export async function sendProductDetail(ctx: any, id: string, page = 1, edit = false) {
  const code = parseListingCode(id);
  if (!code && !/^[a-f\d]{24}$/i.test(id)) return false;
  const product = await Product.findOne({
    ...(code ? { listingCode: code } : { _id: id }), listingType: 'public', status: { $in: ['active', 'reserved', 'sold'] },
  }).select('-sensitiveData').populate('sellerId', 'username trustLevel sellerStats');
  if (!product) return false;
  const seller = product.sellerId as any;
  const description = Array.from(product.description);
  const rows: any[][] = [];
  if (product.status === 'active') rows.push([{ text: 'Sotib olish', callback_data: `buy_${product._id}` }]);
  if (description.length > 2200) rows.push([{ text: 'To‘liq tavsifni o‘qish', callback_data: `description_${product._id}` }]);
  rows.push([{ text: 'Rasmlar va e’lonni saytda ko‘rish', url: `${config.siteUrl.replace(/\/$/, '')}/product/${product._id}` }]);
  rows.push([{ text: '← Katalogga qaytish', callback_data: `catalog_page_${page}` }]);
  const text = [
    `<b>${escapeHtml(product.title)}</b>`,
    `ID: <code>${product.listingCode || '—'}</code> · ${escapeHtml(product.category)}`,
    `Narx: <b>${formatUzs(product.price)}</b>`,
    `Holat: ${product.status === 'active' ? 'Sotuvda' : product.status === 'reserved' ? 'Band qilingan' : 'Sotilgan'}`,
    '', escapeHtml(description.slice(0, 2200).join('')) + (description.length > 2200 ? '…' : ''), '',
    `Sotuvchi: ${escapeHtml(seller?.username || 'Bitmax foydalanuvchisi')} · ${seller?.sellerStats?.sold || 0} ta sotuv`,
    seller?.sellerStats?.ratingCount ? `Baho: ${(seller.sellerStats.ratingSum / seller.sellerStats.ratingCount).toFixed(1)}/5 (${seller.sellerStats.ratingCount})` : 'Hali baholanmagan', '',
    '🔒 Login va parol to‘lovdan keyin ochiladi. Pul tekshirish vaqtida kafilda saqlanadi.',
    `Tekshirish muddati: ${config.autoReleaseHours} soat. To‘lovdan oldin qaytarish shartlarini saytda ko‘ring.`,
  ].join('\n');
  const options = { parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
  return true;
}

/** Explicit /id works in a wizard; bare six-character input is reserved for the active form. */
export async function listingLookup(ctx: any, next: () => Promise<void>) {
  const text = ctx.message?.text?.trim();
  if (!text) return next();
  const explicit = /^\/id(?:@[a-z\d_]+)?(?:\s|$)/i.test(text) || text.startsWith('#');
  // Ordinary menu labels (Balans, Yordam) must never be mistaken for letter-only IDs.
  if (!explicit && !/\d/.test(text)) return next();
  const inWizard = Boolean(ctx.session?.__scenes?.current);
  if (inWizard && !explicit) return next();
  const code = parseListingCode(text);
  if (!code) {
    if (explicit) return ctx.reply('E’lon ID’sini yozing: /id 123456');
    return next();
  }
  if (!await sendProductDetail(ctx, code)) return ctx.reply('Bu ID bilan ochiq e’lon topilmadi. Raqamni tekshiring yoki katalogni oching.');
  if (inWizard) {
    delete ctx.session.__scenes;
    for (const key of ['productData', 'dealData', 'cardData', 'payoutData', 'cardNumber']) delete ctx.session[key];
    await ctx.reply('E’lon ochildi. Oldingi forma bekor qilindi.');
  }
}
