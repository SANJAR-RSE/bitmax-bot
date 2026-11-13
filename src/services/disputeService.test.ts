import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { Dispute } from '../models/Dispute';
import { EscrowHold } from '../models/EscrowHold';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { DisputeNotAllowedError, MAX_EVIDENCE, addEvidence, disputeSplit, openDispute, resolveDispute } from './disputeService';
import { notificationService } from './notificationService';
import { AlreadyProcessedError, ForbiddenError, paymentService } from './paymentService';

// No database: model calls are replaced so each test pins down which writes a step may make.

const oid = () => new mongoose.Types.ObjectId();

beforeEach(() => {
  mock.method(AuditLog, 'create', async () => ({}));
  mock.method(User, 'findById', async () => ({ telegramId: 1, username: 'u' }));
  mock.method(Product, 'findById', async () => ({ title: 'PUBG <akkaunt>' }));
  mock.method(notificationService, 'notifyAdmin', async () => true);
  mock.method(notificationService, 'notifySeller', async () => true);
  mock.method(notificationService, 'notifyBuyer', async () => true);
});
afterEach(() => mock.restoreAll());

function openHold(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid(), transactionId: oid(), productId: oid(), buyerId: oid(), sellerId: oid(),
    status: 'holding', amount: 100_000, sellerPayout: 93_000, commission: 7_000,
    credentialsRevealedAt: new Date(Date.now() - 30 * 3600_000), ...overrides,
  };
}

// ── Opening ────────────────────────────────────────────────────────────────────

test('opening a dispute freezes the escrow and tells the admin, with decision buttons', async () => {
  const hold = openHold();
  mock.method(EscrowHold, 'findById', async () => hold);
  const freeze = mock.method(EscrowHold, 'findOneAndUpdate', async () => ({ ...hold, status: 'disputed' }));
  const created = mock.method(Dispute, 'create', async (doc: any) => ({ ...doc, _id: oid() }));

  const dispute: any = await openDispute(String(hold._id), String(hold.buyerId), 'not_working', 'Parol ishlamayapti');

  const [filter, update] = freeze.mock.calls[0].arguments as any[];
  assert.equal(filter.status, 'holding', 'only an open escrow can be frozen');
  assert.equal(String(filter.buyerId), String(hold.buyerId));
  assert.deepEqual(update, { $set: { status: 'disputed' } });
  assert.equal(created.mock.callCount(), 1);
  assert.equal(dispute.category, 'not_working');
  assert.equal(dispute.amount, 100_000);
  assert.match(dispute.reason, /Parol ishlamayapti/);

  const admin = (notificationService.notifyAdmin as any).mock.calls[0].arguments;
  assert.match(admin[0], /PUBG &lt;akkaunt&gt;/, 'titles are escaped for Telegram HTML');
  assert.deepEqual(admin[1].flat().map((b: any) => b.callback_data.replace(/_[a-f0-9]{24}$/, '')), ['dsp_res_buyer', 'dsp_res_split', 'dsp_res_seller', 'dsp_evv']);
});

test('a dispute cannot be opened before the credentials were opened (refund is 100% then)', async () => {
  const hold = openHold({ credentialsRevealedAt: undefined });
  mock.method(EscrowHold, 'findById', async () => hold);
  const freeze = mock.method(EscrowHold, 'findOneAndUpdate', async () => hold);

  await assert.rejects(openDispute(String(hold._id), String(hold.buyerId), 'other'), DisputeNotAllowedError);
  assert.equal(freeze.mock.callCount(), 0);
});

test('nobody can open a dispute on someone else’s order', async () => {
  const hold = openHold();
  mock.method(EscrowHold, 'findById', async () => hold);
  const freeze = mock.method(EscrowHold, 'findOneAndUpdate', async () => hold);

  await assert.rejects(openDispute(String(hold._id), String(oid()), 'other'), ForbiddenError);
  assert.equal(freeze.mock.callCount(), 0);
});

test('an order that already settled cannot be disputed', async () => {
  const hold = openHold();
  mock.method(EscrowHold, 'findById', async () => hold); // stale read: still "holding"
  mock.method(EscrowHold, 'findOneAndUpdate', async () => null); // released in the meantime
  const created = mock.method(Dispute, 'create', async () => ({}));

  await assert.rejects(openDispute(String(hold._id), String(hold.buyerId), 'other'), AlreadyProcessedError);
  assert.equal(created.mock.callCount(), 0);
});

test('if the dispute record cannot be written, the escrow is unfrozen again', async () => {
  const hold = openHold();
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(EscrowHold, 'findOneAndUpdate', async () => ({ ...hold, status: 'disputed' }));
  mock.method(Dispute, 'create', async () => { throw new Error('db down'); });
  const unfreeze = mock.method(EscrowHold, 'updateOne', async () => ({ modifiedCount: 1 }));

  await assert.rejects(openDispute(String(hold._id), String(hold.buyerId), 'other'), /db down/);
  assert.deepEqual(unfreeze.mock.calls[0].arguments.slice(0, 2), [
    { _id: hold._id, status: 'disputed' },
    { $set: { status: 'holding' } },
  ]);
});

test('an unknown reason is refused', async () => {
  await assert.rejects(openDispute(String(oid()), String(oid()), 'whatever'), DisputeNotAllowedError);
});

// ── Deciding ───────────────────────────────────────────────────────────────────

test('every outcome divides exactly the held amount', () => {
  for (const amount of [1_000, 50_001, 100_000, 333_333]) {
    const sellerPayout = amount - Math.round(amount * 0.07);
    const hold = { amount, sellerPayout, commission: amount - sellerPayout };
    for (const outcome of ['buyer', 'split', 'seller'] as const) {
      const s = disputeSplit(outcome, hold);
      assert.equal(s.buyerAmount + s.sellerAmount + s.platformAmount, amount, `${outcome} @ ${amount}`);
    }
  }
  const hold = { amount: 100_000, sellerPayout: 93_000, commission: 7_000 };
  assert.deepEqual(disputeSplit('buyer', hold), { buyerAmount: 100_000, sellerAmount: 0, platformAmount: 0 });
  assert.deepEqual(disputeSplit('seller', hold), { buyerAmount: 0, sellerAmount: 93_000, platformAmount: 7_000 });
  assert.equal(disputeSplit('split', hold).buyerAmount, 50_000);
});

test('an admin decision settles the frozen escrow and closes the dispute', async () => {
  const hold = openHold({ status: 'disputed' });
  const disputeId = oid();
  mock.method(Dispute, 'findOne', async () => ({ _id: disputeId, escrowHoldId: hold._id, buyerId: hold.buyerId, sellerId: hold.sellerId, productId: hold.productId }));
  mock.method(EscrowHold, 'findById', async () => hold);
  const settle = mock.method(paymentService, 'settleByArbitration', async () => undefined);
  const close = mock.method(Dispute, 'updateOne', async () => ({ modifiedCount: 1 }));

  const result = await resolveDispute(String(disputeId), 'buyer', String(oid()));

  assert.equal(result.ok, true);
  assert.deepEqual((settle.mock.calls[0].arguments as any[])[1], { buyerAmount: 100_000, sellerAmount: 0, platformAmount: 0 });
  assert.equal((close.mock.calls[0].arguments as any[])[1].$set.status, 'resolved_buyer');
  const buyerNotice = (notificationService.notifyBuyer as any).mock.calls.at(-1).arguments[1];
  assert.match(buyerNotice, /100 000|100,000|100000/);
});

test('a second click on a decided dispute moves no money and records the real outcome', async () => {
  // The first decision refunded the buyer but crashed before closing the dispute record.
  const hold = openHold({ status: 'refunded' });
  mock.method(Dispute, 'findOne', async () => ({ _id: oid(), escrowHoldId: hold._id }));
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(paymentService, 'settleByArbitration', async () => { throw new AlreadyProcessedError(); });
  const close = mock.method(Dispute, 'updateOne', async () => ({ modifiedCount: 1 }));
  const notices = mock.method(notificationService, 'notifySeller', async () => true);

  const result = await resolveDispute(String(oid()), 'seller', String(oid())); // a different click

  assert.equal(result.ok, false);
  assert.equal(notices.mock.callCount(), 0, 'nobody is told a decision that did not happen');
  const [filter, update] = close.mock.calls[0].arguments as any[];
  assert.deepEqual(filter.status, { $in: ['open', 'under_review'] });
  assert.equal(update.$set.status, 'resolved_buyer', 'closed from what the escrow actually did, not from the click');
});

test('a dispute whose escrow is still frozen is left open after a failed click', async () => {
  const hold = openHold({ status: 'disputed' });
  mock.method(Dispute, 'findOne', async () => ({ _id: oid(), escrowHoldId: hold._id }));
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(paymentService, 'settleByArbitration', async () => { throw new AlreadyProcessedError(); });
  const close = mock.method(Dispute, 'updateOne', async () => ({ modifiedCount: 1 }));

  await resolveDispute(String(oid()), 'buyer', String(oid()));
  assert.equal(close.mock.callCount(), 0);
});

test('a dispute that is already closed is refused', async () => {
  mock.method(Dispute, 'findOne', async () => null);
  const settle = mock.method(paymentService, 'settleByArbitration', async () => undefined);

  const result = await resolveDispute(String(oid()), 'buyer', String(oid()));
  assert.equal(result.ok, false);
  assert.equal(settle.mock.callCount(), 0);
});

// ── Settlement path ────────────────────────────────────────────────────────────

test('arbitration only settles an escrow that is frozen by a dispute', async () => {
  mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (fn: () => Promise<unknown>) => fn(),
    endSession: async () => undefined,
  }) as any);
  const claim = mock.method(EscrowHold, 'findOneAndUpdate', async () => null);

  await assert.rejects(
    paymentService.settleByArbitration(String(oid()), { buyerAmount: 100_000, sellerAmount: 0, platformAmount: 0 }, 'note', String(oid())),
    AlreadyProcessedError
  );
  const [filter, update] = claim.mock.calls[0].arguments as any[];
  assert.equal(filter.status, 'disputed', 'an open (holding) escrow is never settled by hand');
  assert.equal(update.$set.status, 'refunded', 'a full refund is "refunded", not "partial_refunded"');
});

test('a split decision is recorded as a partial refund', async () => {
  const settle = mock.method(paymentService as any, 'settleEscrow', async () => undefined);
  await paymentService.settleByArbitration(String(oid()), { buyerAmount: 50_000, sellerAmount: 46_500, platformAmount: 3_500 }, 'n', String(oid()));
  const opts = (settle.mock.calls[0].arguments as any[])[1];
  assert.equal(opts.escrowStatus, 'partial_refunded');
  assert.equal(opts.fromStatus, 'disputed');
});

// ── Evidence ───────────────────────────────────────────────────────────────────

test('a party adds evidence to an open dispute with one conditional write', async () => {
  const buyerId = oid();
  const saved = mock.method(Dispute, 'findOneAndUpdate', async () => ({ _id: oid(), evidence: [{}] }));
  await addEvidence(String(oid()), String(buyerId), { kind: 'photo', ref: 'AgACfile', note: ' skrinshot ' });

  const [filter, update] = saved.mock.calls[0].arguments as any[];
  assert.deepEqual(filter.status, { $in: ['open', 'under_review'] }, 'only while open');
  assert.deepEqual(filter.$or.map((c: any) => String(Object.values(c)[0])), [String(buyerId), String(buyerId)], 'only a party');
  assert.deepEqual(filter[`evidence.${MAX_EVIDENCE - 1}`], { $exists: false }, 'never past the cap');
  assert.equal(update.$push.evidence.kind, 'photo');
  assert.equal(update.$push.evidence.note, 'skrinshot');
});

test('evidence refusals say why: stranger, closed dispute, full dispute, empty text', async () => {
  const buyerId = oid();
  const sellerId = oid();
  mock.method(Dispute, 'findOneAndUpdate', async () => null);
  const find = mock.method(Dispute, 'findById', async () => ({ buyerId, sellerId, status: 'open' }));

  await assert.rejects(addEvidence(String(oid()), String(oid()), { kind: 'text', note: 'x' }), ForbiddenError);
  await assert.rejects(addEvidence(String(oid()), String(buyerId), { kind: 'text', note: 'x' }), /20 tadan/);
  find.mock.mockImplementation(async () => ({ buyerId, sellerId, status: 'resolved_buyer' }));
  await assert.rejects(addEvidence(String(oid()), String(sellerId), { kind: 'text', note: 'x' }), /yopilgan/);
  await assert.rejects(addEvidence(String(oid()), String(buyerId), { kind: 'text', note: '   ' }), DisputeNotAllowedError);
  await assert.rejects(addEvidence(String(oid()), String(buyerId), { kind: 'photo' }), DisputeNotAllowedError);
});

test('both sides are offered the evidence button when a dispute opens', async () => {
  const hold = openHold();
  mock.method(EscrowHold, 'findById', async () => hold);
  mock.method(EscrowHold, 'findOneAndUpdate', async () => ({ ...hold, status: 'disputed' }));
  mock.method(Dispute, 'create', async (doc: any) => ({ ...doc, _id: oid() }));

  await openDispute(String(hold._id), String(hold.buyerId), 'other');
  for (const notice of [notificationService.notifyBuyer, notificationService.notifySeller] as any[]) {
    const buttons = notice.mock.calls.at(-1).arguments[2];
    assert.match(buttons?.flat()[0]?.callback_data || '', /^dsp_ev_[a-f0-9]{24}$/);
  }
});
