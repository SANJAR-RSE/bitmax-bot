import crypto from 'crypto';

/**
 * Adds a random tail to the price so the bank SMS identifies which buyer paid. The tail is
 * drawn with a CSPRNG rather than Math.random: a buyer who could predict the next tail could
 * craft a transfer that claims someone else's pending order.
 */
export function generateUniqueAmount(basePrice: number): number {
  const randomTail = crypto.randomInt(100, 1000); // 100..999 so'm
  return basePrice + randomTail;
}

// UZS bank SMS amounts are always whole so'm, commonly written with a thousands
// separator (space, comma, apostrophe or dot), e.g. "1 250 000 so'm" or "1,250,000 UZS".
// We capture the whole run of digits+separators before the currency marker and strip the
// separators, rather than the old \d{1,6} pattern which silently failed (or truncated) on
// any amount over 999,999 or written with a separator.
const CURRENCY_MARKER = "(?:so['’]?m|sum|UZS|uzs|сум|сўм)";

/**
 * Words that mark an SMS as a debit/withdrawal rather than an incoming transfer. Crediting an
 * order because the account was *charged* would confirm payments that never arrived, so those
 * messages are rejected outright.
 *
 * Uzbek banks send the same message in Uzbek, Russian Cyrillic and Latin-transliterated
 * Russian depending on the bank and the card's language setting, so all three spellings of
 * each marker have to be here — matching only Cyrillic "списан" would miss "Spisano".
 */
const OUTGOING_MARKERS = new RegExp(
  [
    // Uzbek
    "yechildi|yechib|yechim|xarid|to['’]?lov amalga",
    // Russian, Cyrillic
    'списан|оплата|покупка|снятие|расход',
    // Russian, Latin transliteration
    'spisan|oplata|pokupka|snyatie|rasxod|raschod',
    // English (some banks / aggregators)
    'debit|withdrawal|purchase',
  ].join('|'),
  'i'
);

const INCOMING_MARKERS = new RegExp(
  [
    // Uzbek
    "tushdi|kirim|o['’]?tkazma|qabul|hisobingizga",
    // Russian, Cyrillic
    'пополнен|зачислен|поступ|перевод|приход',
    // Russian, Latin transliteration
    'popolnen|zachislen|postupil|perevod|prixod|prihod',
    // English
    'credit|incoming|deposit',
  ].join('|'),
  'i'
);

export interface SmsAmount {
  amount: number;
  /**
   * True when unrelated digits sit right in front of the amount, so its first thousand group
   * may belong to them: in "12.11.26 500 437 UZS" the amount is 500 437 or 26 500 437, and the
   * text alone cannot say which. Such a message must never settle an order automatically.
   */
  ambiguous: boolean;
}

export function extractAmountFromSms(text: string): number | null {
  return extractSmsAmount(text)?.amount ?? null;
}

export function extractSmsAmount(text: string): SmsAmount | null {
  // The run of digits and separators that ends right before the currency marker. It can start
  // with unrelated digits (a time, a card tail), so it is parsed from the right below.
  const pattern = new RegExp(`(\\d[\\d\\s.,'’]*)\\s*${CURRENCY_MARKER}`, 'i');
  const match = pattern.exec(text);
  if (!match) return null;
  return parseAmountRun(match[1], text[match.index - 1] || '');
}

/**
 * `1 250 437.00` → 1250437. Banks append kopeks (".00" / ",00"); stripping every separator,
 * as before, turned those into two extra digits and made the amount 100× too large, so no
 * order ever matched. Thousand groups are read from the right: the last groups must be three
 * digits, and at most one shorter group may lead. Anything further left (the "05" of "14:05",
 * a card tail) is not part of the amount.
 */
function parseAmountRun(raw: string, charBefore: string): SmsAmount | null {
  const cleaned = raw.trim().replace(/[.,]\d{1,2}$/, '');
  const groups = cleaned.split(/[\s.,'’]+/).filter(Boolean);
  if (groups.length === 0) return null;

  const last = groups[groups.length - 1];
  let digits: string;
  let ambiguous: boolean;
  if (groups.length === 1 || last.length !== 3) {
    digits = last;
    // A long ungrouped number cannot absorb what precedes it; a short one ("… 12 50 UZS") can.
    ambiguous = groups.length > 1 && last.length < 3;
  } else {
    let start = groups.length - 1;
    while (start > 0 && groups[start - 1].length === 3) start--;
    const leadIndex = start - 1;
    const lead = groups[leadIndex];
    // A lead group that begins with 0, or that directly follows a colon, is the tail of a time.
    const leadOk = lead !== undefined && /^[1-9]\d{0,2}$/.test(lead) && !(leadIndex === 0 && charBefore === ':');
    digits = (leadOk ? lead : '') + groups.slice(start).join('');
    // Certain only when nothing but the amount (and at most an unmistakable time tail at the
    // very start) is in the run. Any further digits mean the lead group is a guess.
    ambiguous = leadIndex > 0;
  }

  const amount = parseInt(digits, 10);
  return Number.isSafeInteger(amount) && amount > 0 ? { amount, ambiguous } : null;
}

/**
 * A so'm amount typed by a person: `150000`, `150 000`, `150,000`, `150 000 so'm`, `150000.00`.
 * Returns null for anything else rather than guessing. Stripping every non-digit, as the payout
 * step used to, read "100 000,00" as 10 000 000 — a withdrawal 100× what was meant.
 */
export function parseSomInput(input: string): number | null {
  const text = String(input).trim()
    .replace(/\s*(?:so['’]?m|sum|uzs|сум)\.?$/i, '')
    .replace(/[.,]\d{1,2}$/, '');
  if (!/^(?:\d{1,3}(?:[\s.,'’]\d{3})+|\d+)$/.test(text)) return null;
  const amount = Number(text.replace(/[\s.,'’]/g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/**
 * True when the SMS looks like money arriving. A message that carries an outgoing marker and
 * no incoming marker is treated as a debit notification and must not confirm an order.
 */
export function looksLikeIncomingPayment(text: string): boolean {
  const outgoing = OUTGOING_MARKERS.test(text);
  const incoming = INCOMING_MARKERS.test(text);
  if (outgoing && !incoming) return false;
  return true;
}

/** Stable identity for an SMS delivery, used to drop redeliveries of the same message. */
export function smsFingerprint(text: string, sender?: string, receivedAt?: string | number): string {
  return crypto
    .createHash('sha256')
    .update(`${sender || ''}|${String(receivedAt || '')}|${text.trim()}`)
    .digest('hex');
}

/** `8600 1234 5678 9012` → `8600 •••• •••• 9012`. Only the masked form is ever displayed. */
export function maskCard(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 8) return '••••';
  return `${digits.slice(0, 4)} •••• •••• ${digits.slice(-4)}`;
}

/**
 * `8600123456789012` → `8600 1234 5678 9012`. Used where the buyer has to *type the number
 * into a banking app* — the platform's own receiving card on the payment screen. Everywhere a
 * card belongs to a user (payout destinations), maskCard is the only correct formatter.
 */
export function formatCardNumber(cardNumber: string): string {
  const digits = String(cardNumber).replace(/\D/g, '');
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

export function isValidUzCard(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  return digits.length === 16;
}

/**
 * Alphabet for deal codes. I/O/0/1 are excluded because the code is read aloud, forwarded in
 * chat and retyped by hand — "was that a one or an ell?" is a support ticket we don't need.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Code the seller hands to their agreed buyer for a private escrow deal.
 *
 * Eight characters from a 32-symbol alphabet is 32^8 ≈ 1.1 × 10^12 combinations, drawn from a
 * CSPRNG — far past guessing range, especially with the attempt limiter on the entry handler.
 * Formatted in two groups because people copy it more reliably that way.
 */
export function generateDealCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** `ABCD2345` → `ABCD-2345` for display. */
export function formatDealCode(code: string): string {
  const clean = normalizeDealCode(code);
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/** Accepts whatever the buyer types — spaces, dashes, lowercase — and returns the stored form. */
export function normalizeDealCode(input: string): string {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Escapes HTML so user-supplied text can't inject markup into a Telegram HTML message. */
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatUzs(amount: number): string {
  return `${Math.round(amount).toLocaleString('en-US').replace(/,/g, ' ')} UZS`;
}

/**
 * Renders a deadline as an absolute local date/time ("13-avgust, 14:00") rather than a relative
 * duration ("72 soat"). Two different clocks (`autoReleaseHours` and `unrevealedGraceHours`)
 * are both phrased as "N soat ichida" in the product's copy, which made them easy to conflate —
 * an absolute timestamp for each is unambiguous regardless of which clock it belongs to.
 */
export function formatDeadline(date: Date): string {
  return date.toLocaleString('uz-UZ', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
