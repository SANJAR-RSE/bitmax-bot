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
const AMOUNT_RUN = "\\d{1,3}(?:[\\s.,']\\d{3})*(?:[\\s.,']\\d{1,2})?|\\d+";

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

export function extractAmountFromSms(text: string): number | null {
  const pattern = new RegExp(`(${AMOUNT_RUN})\\s*${CURRENCY_MARKER}`, 'i');
  const match = text.match(pattern);
  if (!match) return null;

  const digitsOnly = match[1].replace(/[\s.,']/g, '');
  const amount = parseInt(digitsOnly, 10);
  return !isNaN(amount) && amount > 0 ? amount : null;
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
