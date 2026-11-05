import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wizardEscape } from './escape';

function inWizard(extra: Record<string, unknown>) {
  return { session: { __scenes: { current: 'seller_create' }, productData: { title: 'draft' } }, ...extra } as any;
}

test('a login deep link leaves the form and reaches the start handler', async () => {
  const ctx = inWizard({ message: { text: '/start login_abc' } });
  let continued = false;
  await wizardEscape(ctx, async () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(ctx.session.__scenes, undefined);
  assert.equal(ctx.session.productData, undefined);
});

test('a menu button leaves the form, ordinary input stays in it', async () => {
  const menu = inWizard({ message: { text: 'Balans' } });
  await wizardEscape(menu, async () => {});
  assert.equal(menu.session.__scenes, undefined);

  const input = inWizard({ message: { text: 'Instagram 12k obunachi' } });
  await wizardEscape(input, async () => {});
  assert.equal(input.session.__scenes.current, 'seller_create');
  assert.deepEqual(input.session.productData, { title: 'draft' });
});

test('a button from another screen is answered without disturbing the form', async () => {
  let answer = '';
  let continued = false;
  const ctx = inWizard({ callbackQuery: { data: 'confirm_escrow_1' }, answerCbQuery: async (text: string) => { answer = text; } });
  await wizardEscape(ctx, async () => { continued = true; });
  assert.equal(continued, false);
  assert.match(answer, /formani/);
  assert.equal(ctx.session.__scenes.current, 'seller_create');
});

test('the form keeps its own buttons, and nothing changes outside a form', async () => {
  for (const data of ['photos_done', 'photos_skip', 'seller_publish_confirm', 'deal_publish_cancel', 'role_seller']) {
    let continued = false;
    await wizardEscape(inWizard({ callbackQuery: { data } }), async () => { continued = true; });
    assert.equal(continued, true, data);
  }
  let continued = false;
  await wizardEscape({ session: {}, callbackQuery: { data: 'confirm_escrow_1' } }, async () => { continued = true; });
  assert.equal(continued, true);
});
