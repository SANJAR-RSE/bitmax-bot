import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAmountFromSms,
  looksLikeIncomingPayment,
  generateUniqueAmount,
  smsFingerprint,
  maskCard,
  isValidUzCard,
  escapeHtml,
  generateDealCode,
  normalizeDealCode,
  formatDealCode,
} from './helpers';

test('parses the amount out of real-world UZS bank SMS shapes', () => {
  const cases: Array<[string, number]> = [
    ["Hisobingizga 50 247 so'm tushdi. Balans: 1 250 000 so'm", 50247],
    ['Postupilo 1,250,000 UZS na schet', 1250000],
    ["Kirim: 999999 so'm", 999999],
    ["8600****1234 hisobiga 12 500 000 so'm o'tkazma qabul qilindi", 12500000],
    ['Zachislenie 75000 сум', 75000],
    ["Hisobingizga 1.500.000 so'm tushdi", 1500000],
  ];

  for (const [sms, expected] of cases) {
    assert.equal(extractAmountFromSms(sms), expected, `failed on: ${sms}`);
  }
});

test('amounts above 999,999 are not truncated', () => {
  // v1's \d{1,6} pattern silently mis-read or dropped any amount over six digits, so every
  // sale above a million so'm failed to confirm.
  assert.equal(extractAmountFromSms("Hisobingizga 5 000 000 so'm tushdi"), 5000000);
});

test('returns null when there is no amount to find', () => {
  assert.equal(extractAmountFromSms('Xush kelibsiz! Bizning xizmatlarimizdan foydalaning'), null);
  assert.equal(extractAmountFromSms(''), null);
});

test('a debit notification is not treated as an incoming payment', () => {
  // Confirming an order because our own card was *charged* would mark orders paid that nobody
  // ever paid for.
  assert.equal(looksLikeIncomingPayment("Hisobingizdan 50 247 so'm yechildi"), false);
  assert.equal(looksLikeIncomingPayment('Spisano 50247 UZS. Pokupka'), false);
  assert.equal(looksLikeIncomingPayment("Hisobingizga 50 247 so'm tushdi"), true);
  assert.equal(looksLikeIncomingPayment('Postupilo 50247 UZS'), true);
});

test('a transfer message that mentions both directions is still accepted', () => {
  // Some banks phrase an incoming transfer with wording that also trips the debit markers;
  // an explicit incoming marker wins so a real payment is never rejected.
  assert.equal(
    looksLikeIncomingPayment("Karta hisobingizga o'tkazma: 50 247 so'm. Xarid emas."),
    true
  );
});

test('the unique amount stays within one tail of the price', () => {
  for (let i = 0; i < 200; i++) {
    const amount = generateUniqueAmount(50_000);
    assert.ok(amount >= 50_100 && amount <= 50_999, `tail out of range: ${amount}`);
    assert.ok(Number.isInteger(amount));
  }
});

test('the same SMS delivered twice produces the same fingerprint', () => {
  const a = smsFingerprint('Test 1000 UZS', '8600', 1700000000);
  const b = smsFingerprint('Test 1000 UZS', '8600', 1700000000);
  const c = smsFingerprint('Test 1000 UZS', '8600', 1700000001);

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('surrounding whitespace does not change a fingerprint', () => {
  assert.equal(
    smsFingerprint('  Test 1000 UZS  ', '8600', 1),
    smsFingerprint('Test 1000 UZS', '8600', 1)
  );
});

test('card masking keeps only the first and last four digits', () => {
  assert.equal(maskCard('8600123456789012'), '8600 •••• •••• 9012');
  assert.equal(maskCard('8600 1234 5678 9012'), '8600 •••• •••• 9012');
  assert.equal(maskCard('123'), '••••');
});

test('card validation requires sixteen digits', () => {
  assert.equal(isValidUzCard('8600 1234 5678 9012'), true);
  assert.equal(isValidUzCard('8600123456789012'), true);
  assert.equal(isValidUzCard('86001234567890'), false);
});

test('deal codes avoid characters people misread when retyping', () => {
  // The code gets read aloud and forwarded in chat, so I/O/0/1 must never appear.
  for (let i = 0; i < 500; i++) {
    const code = generateDealCode();
    assert.equal(code.length, 8);
    assert.match(code, /^[A-HJ-NP-Z2-9]+$/, `ambiguous character in ${code}`);
  }
});

test('deal codes do not repeat across a large sample', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 2000; i++) codes.add(generateDealCode());
  assert.equal(codes.size, 2000);
});

test('a buyer can type the code however they like', () => {
  // Whatever the seller pasted and the buyer retyped has to land on the same stored value.
  for (const input of ['ABCD2345', 'abcd-2345', 'ABCD 2345', ' abcd2345 ', 'AbCd-23 45']) {
    assert.equal(normalizeDealCode(input), 'ABCD2345', `failed on: ${input}`);
  }
});

test('deal codes are displayed in two groups', () => {
  assert.equal(formatDealCode('ABCD2345'), 'ABCD-2345');
  assert.equal(formatDealCode('abcd-2345'), 'ABCD-2345');
});

test('user text cannot inject markup into a Telegram HTML message', () => {
  assert.equal(
    escapeHtml('<b>bold</b> & <script>alert(1)</script>'),
    '&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;'
  );
});
