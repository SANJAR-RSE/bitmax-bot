import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogKeyboard, listingLookup } from './catalog';
test('ten listing buttons include prices, website and bounded pagination', () => {
  const products = Array.from({ length: 10 }, (_, i) => ({ _id: String(i).padStart(24, '0'), title: `Akkaunt ${i}`, price: 1000 + i }));
  const rows = catalogKeyboard(products, 2, 3).inline_keyboard;
  assert.ok(rows[0][0].url.endsWith('/katalog'));
  const buttons = rows.flat().filter(b => b.callback_data?.startsWith('detail_'));
  assert.equal(buttons.length, 10);
  for (const b of buttons) { assert.match(b.text, /Akkaunt \d · /); assert.ok(Buffer.byteLength(b.callback_data) <= 64); }
  assert.deepEqual(rows.at(-1)?.map(b => b.callback_data), ['catalog_page_1', 'catalog_page_3']);
  assert.equal(catalogKeyboard(products, 1, 1).inline_keyboard.flat().filter(b => b.callback_data?.startsWith('catalog_page')).length, 0);
});
test('six-digit wizard input remains a price or password', async () => {
  let continued = false;
  await listingLookup({ message: { text: '250000' }, session: { __scenes: { current: 'seller_create' } } }, async () => { continued = true; });
  assert.equal(continued, true);
});

test('ordinary six-letter menu labels continue to menu handlers', async () => {
  for (const text of ['Balans', 'Yordam']) {
    let continued = false;
    await listingLookup({ message: { text }, session: {} }, async () => { continued = true; });
    assert.equal(continued, true);
  }
});
