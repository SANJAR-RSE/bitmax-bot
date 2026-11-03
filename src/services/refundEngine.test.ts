import test from 'node:test';
import assert from 'node:assert/strict';

import {
  quoteRefund,
  calculateRefundAmount,
  calculateSellerPayout,
  resolveTier,
  refundDeadlineFrom,
} from './refundEngine';
import { config } from '../config';

const AMOUNT = 1_000_000;
const now = new Date('2026-08-08T12:00:00Z');

function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

test('the four shares always add back up to the amount', () => {
  // The invariant that matters most: money is never created or destroyed by a refund. Run it
  // across every tier and a spread of amounts, including ones that round awkwardly.
  for (const amount of [1_000, 49_999, 50_247, 333_333, 1_000_000, 7_777_777]) {
    for (const penalty of [0, 10, 50, 100]) {
      const split = calculateRefundAmount(amount, penalty);
      assert.equal(
        split.refundToBuyer + split.sellerKeeps + split.platformKeeps,
        amount,
        `penalty ${penalty}% on ${amount} does not balance`
      );
      assert.ok(split.refundToBuyer >= 0, 'buyer share went negative');
      assert.ok(split.sellerKeeps >= 0, 'seller share went negative');
      assert.ok(split.platformKeeps >= 0, 'platform share went negative');
    }
  }
});

test('a full refund returns 100% to the buyer, not 93%', () => {
  // v1 subtracted the platform commission from a "full" refund, so a buyer promised their
  // money back received 93% of it.
  const quote = quoteRefund({ amount: AMOUNT, boughtAt: minutesAgo(5), revealedAt: minutesAgo(5), now });

  assert.equal(quote.allowed, true);
  assert.equal(quote.period, '0-10min');
  assert.equal(quote.refundToBuyer, AMOUNT);
  assert.equal(quote.penaltyAmount, 0);
  assert.equal(quote.platformKeeps, 0);
  assert.equal(quote.sellerKeeps, 0);
});

test('the 10% tier returns exactly the 90% the message promises', () => {
  // v1 returned 83% here (100 − 10 penalty − 7 commission) while telling the buyer 90%.
  const quote = quoteRefund({ amount: AMOUNT, boughtAt: minutesAgo(45), revealedAt: minutesAgo(45), now });

  assert.equal(quote.period, '10min-2h');
  assert.equal(quote.penaltyPercent, 10);
  assert.equal(quote.refundToBuyer, 900_000);
  assert.equal(quote.penaltyAmount, 100_000);
  // The platform's cut comes out of the forfeited pool, never out of the buyer's share.
  // Derived from config so tuning the commission rate doesn't fail this test spuriously —
  // the buyer's 90% above is the part that must never move.
  const expectedPlatform = Math.round((100_000 * config.platformCommission) / 100);
  assert.equal(quote.platformKeeps, expectedPlatform);
  assert.equal(quote.sellerKeeps, 100_000 - expectedPlatform);
});

test('the 50% tier returns exactly 50%', () => {
  const quote = quoteRefund({ amount: AMOUNT, boughtAt: minutesAgo(300), revealedAt: minutesAgo(300), now });

  assert.equal(quote.period, '2h-24h');
  assert.equal(quote.refundToBuyer, 500_000);
  const expectedPlatform = Math.round((500_000 * config.platformCommission) / 100);
  assert.equal(quote.platformKeeps, expectedPlatform);
  assert.equal(quote.sellerKeeps, 500_000 - expectedPlatform);
});

test('past 24 hours the refund is refused and the seller is paid', () => {
  const quote = quoteRefund({
    amount: AMOUNT,
    boughtAt: minutesAgo(2000),
    revealedAt: minutesAgo(2000),
    now,
  });

  assert.equal(quote.allowed, false);
  assert.equal(quote.period, 'over24h');
  assert.equal(quote.refundToBuyer, 0);
  assert.equal(quote.sellerKeeps + quote.platformKeeps, AMOUNT);
});

test('an order whose credentials were never revealed is always fully refundable', () => {
  // The buyer holds nothing, so no elapsed time can justify a penalty — even a week later.
  const quote = quoteRefund({
    amount: AMOUNT,
    boughtAt: minutesAgo(60 * 24 * 7),
    revealedAt: null,
    now,
  });

  assert.equal(quote.allowed, true);
  assert.equal(quote.refundToBuyer, AMOUNT);
  assert.equal(quote.penaltyPercent, 0);
});

test('the clock runs from the reveal, not from the purchase', () => {
  // Payment confirms automatically and can land while the buyer is asleep. Charging a penalty
  // for hours they never had the credentials would be indefensible.
  const quote = quoteRefund({
    amount: AMOUNT,
    boughtAt: minutesAgo(600), // bought 10 hours ago
    revealedAt: minutesAgo(3), // opened three minutes ago
    now,
  });

  assert.equal(quote.period, '0-10min');
  assert.equal(quote.refundToBuyer, AMOUNT);
  assert.equal(quote.elapsedMinutes, 3);
});

test('tier boundaries are inclusive of their upper edge', () => {
  assert.equal(resolveTier(0).id, '0-10min');
  assert.equal(resolveTier(10).id, '0-10min');
  assert.equal(resolveTier(11).id, '10min-2h');
  assert.equal(resolveTier(120).id, '10min-2h');
  assert.equal(resolveTier(121).id, '2h-24h');
  assert.equal(resolveTier(1440).id, '2h-24h');
  assert.equal(resolveTier(1441).id, 'over24h');
  assert.equal(resolveTier(999_999).id, 'over24h');
});

test('seller payout on a completed sale is amount minus commission', () => {
  const { commission, sellerPayout } = calculateSellerPayout(AMOUNT);
  assert.equal(commission, (AMOUNT * config.platformCommission) / 100);
  assert.equal(commission + sellerPayout, AMOUNT);
});

test('the refund deadline is the end of the last refundable tier', () => {
  const start = new Date('2026-08-08T00:00:00Z');
  const deadline = refundDeadlineFrom(start);
  assert.equal(deadline.getTime() - start.getTime(), 1440 * 60_000);
});

test('the platform never earns more from a refund than from a completed sale', () => {
  // If a cancelled sale were more profitable than a completed one, the platform's incentives
  // would be pointed at its own users.
  const completed = calculateSellerPayout(AMOUNT).commission;
  for (const penalty of [0, 10, 50]) {
    const { platformKeeps } = calculateRefundAmount(AMOUNT, penalty);
    assert.ok(
      platformKeeps <= completed,
      `refund at ${penalty}% earns ${platformKeeps}, more than a completed sale's ${completed}`
    );
  }
});
