import mongoose from 'mongoose';
import { LedgerEntry, ILedgerEntry, IPosting, LedgerEntryType } from '../models/LedgerEntry';
import { User } from '../models/User';

/**
 * Canonical account names. Keeping them behind functions means a typo is a compile error
 * rather than a silently orphaned balance.
 */
export const accounts = {
  /** A user's withdrawable balance. */
  userAvailable: (userId: string | mongoose.Types.ObjectId) => `user:${String(userId)}:available`,
  /** Funds locked for a specific order until it settles. */
  escrow: (escrowHoldId: string | mongoose.Types.ObjectId) => `escrow:${String(escrowHoldId)}`,
  /** Commission and retained penalties — the platform's earnings. */
  platformRevenue: 'platform:revenue',
  /**
   * The outside world (the bank). Money entering the system debits this account and money
   * leaving credits it, which keeps every entry balanced without pretending the platform
   * conjures funds from nothing.
   */
  externalBank: 'external:bank',
};

export interface PostOptions {
  key: string;
  type: LedgerEntryType;
  postings: IPosting[];
  refType?: string;
  refId?: mongoose.Types.ObjectId | string;
  meta?: Record<string, unknown>;
  currency?: string;
}

export class LedgerService {
  /**
   * Appends one journal entry. Safe to call twice with the same `key` — the second call
   * returns the already-stored entry instead of moving money again.
   *
   * Must be called inside the same session/transaction as the state change it accounts for,
   * so the ledger and the domain documents can never disagree.
   */
  async post(
    options: PostOptions,
    session?: mongoose.ClientSession
  ): Promise<{ entry: ILedgerEntry; created: boolean }> {
    const sum = options.postings.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== 0) {
      throw new Error(`Unbalanced ledger entry "${options.key}": postings sum to ${sum}, expected 0`);
    }
    if (options.postings.some((p) => !Number.isInteger(p.amount))) {
      throw new Error(`Ledger entry "${options.key}" has a fractional amount; amounts are whole so'm`);
    }

    try {
      const [entry] = await LedgerEntry.create(
        [
          {
            key: options.key,
            type: options.type,
            currency: options.currency || 'UZS',
            postings: options.postings,
            refType: options.refType,
            refId: options.refId ? new mongoose.Types.ObjectId(String(options.refId)) : undefined,
            meta: options.meta,
          },
        ],
        session ? { session } : {}
      );
      return { entry, created: true };
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await LedgerEntry.findOne({ key: options.key }).session(session ?? null);
        if (existing) return { entry: existing, created: false };
      }
      throw err;
    }
  }

  /**
   * Posts an entry *and* keeps the denormalised `User.balance` cache in step for any user
   * accounts it touches. Callers should prefer this over post() whenever a user balance
   * changes, so a read of User.balance never lags the ledger within a transaction.
   *
   * When the key was already used, the balance effects were applied on the first run and
   * are deliberately not applied again.
   */
  async postAndSync(options: PostOptions, session?: mongoose.ClientSession): Promise<ILedgerEntry> {
    const { entry, created } = await this.post(options, session);
    if (!created) return entry;

    for (const posting of options.postings) {
      const userId = parseUserAccount(posting.account);
      if (!userId) continue;
      await User.findByIdAndUpdate(
        userId,
        { $inc: { balance: posting.amount } },
        session ? { session } : {}
      );
    }

    return entry;
  }

  /** Authoritative balance for an account, computed from the journal. */
  async balanceOf(account: string): Promise<number> {
    const [result] = await LedgerEntry.aggregate([
      { $match: { 'postings.account': account } },
      { $unwind: '$postings' },
      { $match: { 'postings.account': account } },
      { $group: { _id: null, balance: { $sum: '$postings.amount' } } },
    ]);
    return result?.balance ?? 0;
  }

  /** Balances for every account, used by the reconciliation job and admin reporting. */
  async allBalances(): Promise<Record<string, number>> {
    const rows = await LedgerEntry.aggregate([
      { $unwind: '$postings' },
      { $group: { _id: '$postings.account', balance: { $sum: '$postings.amount' } } },
    ]);
    return Object.fromEntries(rows.map((r: any) => [r._id, r.balance]));
  }

  /** Statement for a user, newest first — what the "my transactions" screen renders. */
  async statement(userId: string, limit = 50) {
    const account = accounts.userAvailable(userId);
    const entries = await LedgerEntry.find({ 'postings.account': account })
      .sort('-createdAt')
      .limit(Math.min(200, limit))
      .lean();

    return entries.map((entry) => ({
      id: String(entry._id),
      type: entry.type,
      amount: entry.postings.filter((p) => p.account === account).reduce((s, p) => s + p.amount, 0),
      currency: entry.currency,
      refType: entry.refType,
      refId: entry.refId ? String(entry.refId) : undefined,
      meta: entry.meta,
      createdAt: entry.createdAt,
    }));
  }

  /**
   * Compares every user's cached balance against the ledger. A non-empty result means a
   * write path bypassed the ledger and needs fixing — it is the platform's smoke alarm.
   */
  async findBalanceDrift(): Promise<Array<{ userId: string; cached: number; ledger: number }>> {
    const balances = await this.allBalances();
    const users = await User.find({}, { balance: 1 }).lean();

    const drift: Array<{ userId: string; cached: number; ledger: number }> = [];
    for (const user of users) {
      const ledgerBalance = balances[accounts.userAvailable(String(user._id))] ?? 0;
      if ((user.balance ?? 0) !== ledgerBalance) {
        drift.push({ userId: String(user._id), cached: user.balance ?? 0, ledger: ledgerBalance });
      }
    }
    return drift;
  }
}

function parseUserAccount(account: string): string | null {
  const match = account.match(/^user:([0-9a-fA-F]{24}):available$/);
  return match ? match[1] : null;
}

export const ledgerService = new LedgerService();
