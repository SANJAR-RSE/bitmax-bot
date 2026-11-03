import { Markup } from 'telegraf';

/**
 * One menu for everyone.
 *
 * There used to be three — buyer, seller and admin — and each hid the others' actions. The
 * platform's two reasons to exist (trade an account through the catalog, or run an already
 * agreed deal through escrow) were therefore invisible depending on who you happened to be:
 * an admin saw only moderation queues, a new user saw no way to sell at all. Role now decides
 * what a button *does*, never whether the button is on screen.
 */
export function mainMenu(isAdmin = false) {
  const rows = [
    ['Akkaunt sotib olish', 'Akkaunt sotish'],
    ['Kafil bitim'],
    ['Buyurtmalarim', 'E’lonlarim'],
    ['Balans', 'Sozlamalar'],
    ['Yordam'],
  ];
  if (isAdmin) rows.push(['Admin panel']);
  return Markup.keyboard(rows).resize();
}

/** Default keyboard for the many call sites that just need "the normal menu". */
export const mainMenuKeyboard = mainMenu(false);

/** Retained so existing seller-flow call sites keep compiling; same menu for everyone now. */
export const sellerMenuKeyboard = mainMenuKeyboard;

/** The two sides of an agreed deal — one screen, so neither party hunts for their half. */
export function dealSideButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Men sotyapman — kod yaratish', 'deal_side_seller')],
    [Markup.button.callback('Men sotib olyapman — kodim bor', 'deal_side_buyer')],
  ]);
}

/** The fork every seller hits: escrow-only handover, or a public catalog listing. */
export function sellModeButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Kelishilgan bitim (kod bilan)', 'sell_mode_private')],
    [Markup.button.callback('Bozorga qo‘yish', 'sell_mode_public')],
  ]);
}

export function dealBuyButtons(productId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('To‘lovni boshlash', `buy_${productId}`)],
    [Markup.button.callback('Bekor qilish', 'deal_abort')],
  ]);
}

/** Admin tools sit behind one button rather than replacing the whole menu. */
export const adminMenuKeyboard = Markup.keyboard([
  ['Foydalanuvchilar', 'Statistika'],
  ['Moderatsiya', 'To‘lov so‘rovlari'],
  ['To‘lov inbox', 'Nizolar'],
  ['Asosiy menu'],
]).resize();

export const balanceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('Pul yechish', 'payout_request')],
  [Markup.button.callback('Kartani saqlash', 'payout_card')],
  [Markup.button.callback('Tranzaksiyalar', 'balance_statement')],
]);

export function confirmSellerWarning() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Tushundim, davom etish', 'seller_accept_warning')],
    [Markup.button.callback('Bekor qilish', 'seller_cancel')],
  ]);
}

export function productActionButtons(productId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Sotib olish', `buy_${productId}`),
      Markup.button.callback('Batafsil', `detail_${productId}`),
    ],
  ]);
}

/** Shown after payment confirms — the buyer opens the credentials themselves. */
export function revealButton(escrowId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Ma’lumotlarni ochish', `reveal_${escrowId}`)],
  ]);
}

export function escrowActionButtons(escrowId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Tasdiqlayman', `confirm_escrow_${escrowId}`),
      Markup.button.callback('Qaytarish', `refund_escrow_${escrowId}`),
    ],
    [
      Markup.button.callback('Qayta ko‘rish', `reveal_${escrowId}`),
      Markup.button.callback('Yordam', `help_escrow_${escrowId}`),
    ],
  ]);
}

/**
 * Callback data is capped at 64 bytes and a 24-char ObjectId eats most of it, so the reason
 * prefixes are kept short (`rr_` = refund reason, `rdo_` = refund do it).
 */
export function refundReasonButtons(escrowId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Akkaunt ishlamayapti', `rr_not_working_${escrowId}`)],
    [Markup.button.callback('Ma’lumot noto‘g‘ri', `rr_wrong_info_${escrowId}`)],
    [Markup.button.callback('Asl egasi qaytarib oldi', `rr_recovered_${escrowId}`)],
    [Markup.button.callback('Boshqa sabab', `rr_other_${escrowId}`)],
    [Markup.button.callback('Bekor qilish', `refund_cancel_${escrowId}`)],
  ]);
}

export function refundConfirmButtons(escrowId: string, reasonType: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Ha, qaytaring', `rdo_${reasonType}_${escrowId}`)],
    [Markup.button.callback('Bekor qilish', `refund_cancel_${escrowId}`)],
  ]);
}

/** Admin controls attached to a refund alert. */
export function adminRefundButtons(escrowId: string, sellerId: string, productId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('E’lonni o‘chirish', `adm_delprod_${productId}`)],
    [Markup.button.callback('Sotuvchini bloklash', `adm_ban_${sellerId}`)],
    [Markup.button.callback('Batafsil', `adm_details_${escrowId}`)],
  ]);
}

/** Moderation queue controls. */
export function moderationButtons(productId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Tasdiqlash', `mod_approve_${productId}`),
      Markup.button.callback('Rad etish', `mod_reject_${productId}`),
    ],
  ]);
}

export function payoutButtons(payoutId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Karta raqamini ko‘rish', `po_reveal_${payoutId}`)],
    [
      Markup.button.callback('To‘landi', `po_paid_${payoutId}`),
      Markup.button.callback('Rad etish', `po_reject_${payoutId}`),
    ],
  ]);
}

/** Photo-collection step: "done" once at least one photo is in, "skip" while there are none. */
export function photoStepButtons(count: number) {
  const rows = [[Markup.button.callback('Tayyor', 'photos_done')]];
  if (count === 0) rows.push([Markup.button.callback('O‘tkazib yuborish', 'photos_skip')]);
  return Markup.inlineKeyboard(rows);
}

/** Shown after a deal-code entry locks out at 3 wrong attempts — re-enters CODE_WIZARD. */
export function codeRetryButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('Qayta urinish', 'code_retry')]]);
}

/** Real prev/next paging for the bot catalog, replacing the old "/next" stub. */
export function catalogPageButtons(page: number, pages: number) {
  const row = [];
  if (page > 1) row.push(Markup.button.callback('Oldingi', `catalog_page_${page - 1}`));
  if (page < pages) row.push(Markup.button.callback('Keyingisi', `catalog_page_${page + 1}`));
  return Markup.inlineKeyboard([row]);
}

export function backButton() {
  return Markup.keyboard([['Asosiy menu']]).resize();
}

export function profileSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Bildirishnomalar', 'settings_notifications')],
    [Markup.button.callback('Til / Язык', 'settings_language')],
    [Markup.button.callback('Sotuvchi bo‘lish', 'settings_become_seller')],
    [Markup.button.callback('Orqaga', 'back_main')],
  ]);
}
