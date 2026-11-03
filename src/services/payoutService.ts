import mongoose from 'mongoose';
import { Payout } from '../models/Payout';
import { User } from '../models/User';
import { audit } from '../models/AuditLog';
import { ledgerService, accounts } from './ledgerService';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { maskCard, isValidUzCard } from '../utils/helpers';
import { config } from '../config';

export class InsufficientBalanceError extends Error {
  constructor(message = 'Balansda yetarli mablag‘ yo‘q') {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Withdrawals.
 *
 * The original design credited a `balance` field on refund or sale and stopped there, so
 * money could enter a user's account but never leave it. Funds are debited from the available
 * balance the moment a request is filed — reserving them — rather than when an operator gets
 * around to paying. Otherwise a user could file ten withdrawals against one balance and, if
 * the operator worked the queue quickly, be paid for all ten.
 */
export class PayoutService {
  async setPayoutCard(userId: string, cardNumber: string, holder: string) {
    if (!isValidUzCard(cardNumber)) {
      throw new Error('Karta raqami 16 xonali bo‘lishi kerak');
    }

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          payoutCard: {
            encrypted: encryptSecret(cardNumber.replace(/\D/g, '')),
            masked: maskCard(cardNumber),
            holder,
            updatedAt: new Date(),
          },
        },
      },
      { new: true }
    );

    await audit({
      actorId: new mongoose.Types.ObjectId(userId),
      action: 'user.payout_card_updated',
      targetType: 'User',
      targetId: new mongoose.Types.ObjectId(userId),
      after: { masked: maskCard(cardNumber) },
    });

    return user;
  }

  async requestPayout(userId: string, amount: number) {
    if (!Number.isInteger(amount) || amount < config.minPayoutAmount) {
      throw new Error(`Minimal yechish summasi ${config.minPayoutAmount.toLocaleString()} UZS`);
    }

    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.isBlocked) throw new Error('Hisobingiz bloklangan');
    if (!user.payoutCard?.encrypted) throw new Error('Avval karta raqamingizni saqlang');

    const fee = config.payoutFeeFlat;
    const netAmount = amount - fee;
    if (netAmount <= 0) throw new Error('Summa komissiyani qoplamaydi');

    const session = await mongoose.startSession();
    let payout: any = null;

    try {
      await session.withTransaction(async () => {
        // Conditional decrement: the balance can only go down if it is actually there, so
        // two concurrent withdrawal requests cannot both pass the check.
        const debited = await User.findOneAndUpdate(
          { _id: userId, balance: { $gte: amount } },
          { $inc: { balance: -amount } },
          { new: true, session }
        );
        if (!debited) throw new InsufficientBalanceError();

        const [created] = await Payout.create(
          [
            {
              userId,
              amount,
              fee,
              netAmount,
              destinationMasked: user.payoutCard!.masked,
              destinationEncrypted: user.payoutCard!.encrypted,
              destinationHolder: user.payoutCard!.holder,
              status: 'requested',
              requestedAt: new Date(),
            },
          ],
          { session }
        );

        // Reserving funds leaves the available account and parks them against the bank leg;
        // `payout_paid` later confirms it, `payout_reverted` undoes it.
        await ledgerService.post(
          {
            key: `payout_reserve:${created._id}`,
            type: 'payout_reserved',
            postings: [
              { account: accounts.userAvailable(userId), amount: -amount },
              { account: accounts.externalBank, amount },
            ],
            refType: 'Payout',
            refId: created._id as mongoose.Types.ObjectId,
          },
          session
        );

        payout = created;
      });
    } finally {
      await session.endSession();
    }

    await audit({
      actorId: new mongoose.Types.ObjectId(userId),
      action: 'payout.requested',
      targetType: 'Payout',
      targetId: payout._id,
      after: { amount, netAmount },
    });

    return payout;
  }

  /** Operator confirms the bank transfer actually went out. */
  async markPaid(payoutId: string, adminUserId: string, externalReference?: string) {
    const payout = await Payout.findOneAndUpdate(
      { _id: payoutId, status: { $in: ['requested', 'approved', 'processing'] } },
      {
        $set: {
          status: 'paid',
          processedAt: new Date(),
          processedBy: new mongoose.Types.ObjectId(adminUserId),
          externalReference,
        },
      },
      { new: true }
    );
    if (!payout) throw new Error('To‘lov topilmadi yoki allaqachon yopilgan');

    // No ledger entry here on purpose: the funds already left the user's available account
    // when the request reserved them. Marking it paid is a status change, not a movement —
    // posting a zero-value entry would only add noise to the journal.
    await audit({
      actorId: new mongoose.Types.ObjectId(adminUserId),
      action: 'payout.paid',
      targetType: 'Payout',
      targetId: payout._id as mongoose.Types.ObjectId,
      after: { amount: payout.amount, externalReference },
    });

    return payout;
  }

  /** Rejects a request and returns the reserved funds to the user's available balance. */
  async reject(payoutId: string, adminUserId: string, note: string) {
    const session = await mongoose.startSession();
    let payout: any = null;

    try {
      await session.withTransaction(async () => {
        payout = await Payout.findOneAndUpdate(
          { _id: payoutId, status: { $in: ['requested', 'approved', 'processing'] } },
          {
            $set: {
              status: 'rejected',
              processedAt: new Date(),
              processedBy: new mongoose.Types.ObjectId(adminUserId),
              note,
            },
          },
          { new: true, session }
        );
        if (!payout) throw new Error('To‘lov topilmadi yoki allaqachon yopilgan');

        await ledgerService.postAndSync(
          {
            key: `payout_revert:${payout._id}`,
            type: 'payout_reverted',
            postings: [
              { account: accounts.externalBank, amount: -payout.amount },
              { account: accounts.userAvailable(String(payout.userId)), amount: payout.amount },
            ],
            refType: 'Payout',
            refId: payout._id,
            meta: { note },
          },
          session
        );
      });
    } finally {
      await session.endSession();
    }

    await audit({
      actorId: new mongoose.Types.ObjectId(adminUserId),
      action: 'payout.rejected',
      targetType: 'Payout',
      targetId: payout._id,
      note,
    });

    return payout;
  }

  /** Full card number, for the operator actually making the transfer. Always audited. */
  async revealDestination(payoutId: string, adminUserId: string): Promise<string> {
    const payout = await Payout.findById(payoutId);
    if (!payout) throw new Error('To‘lov topilmadi');

    await audit({
      actorId: new mongoose.Types.ObjectId(adminUserId),
      action: 'payout.destination_revealed',
      targetType: 'Payout',
      targetId: payout._id as mongoose.Types.ObjectId,
    });

    return decryptSecret(payout.destinationEncrypted);
  }

  async listPending(limit = 50) {
    return Payout.find({ status: { $in: ['requested', 'approved', 'processing'] } })
      .sort('requestedAt')
      .limit(limit)
      .populate('userId', 'telegramId username firstName');
  }
}

export const payoutService = new PayoutService();
