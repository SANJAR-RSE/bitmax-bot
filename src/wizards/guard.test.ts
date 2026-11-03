import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bailIfCancelled } from './guard';

test('plain and previous menu buttons cancel a wizard without consuming input', async () => {
  for (const text of ['Asosiy menu', '🏠 Asosiy menu', '/cancel', 'bekor']) {
    let left = false;
    const ctx = { message: { text }, session: { draft: 'secret' }, reply: async () => {}, scene: { leave: async () => { left = true; } } };
    assert.equal(await bailIfCancelled(ctx, ['draft']), true);
    assert.equal(left, true);
    assert.equal(ctx.session.draft, undefined);
  }
});

test('a title beginning with bekor is not treated as cancellation', async () => {
  assert.equal(await bailIfCancelled({ message: { text: 'Bekor qilinmagan akkaunt' } }), false);
});
