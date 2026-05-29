import { DateTime } from "luxon";
import { prisma, Prisma, LedgerReason } from "@cadence/db";
import { redis } from "@/server/redis";

/**
 * Credit model
 * ============
 * Postgres is the source of truth. `CreditBalance.balance` is mutated under a
 * row lock (`SELECT ... FOR UPDATE`) so concurrent consume/grant calls for the
 * same user serialize instead of racing. Every mutation writes a `CreditLedger`
 * row whose unique `idempotencyKey` is the real guard against double-spend and
 * double-grant under webhook/cron retries.
 *
 * Redis holds a mirror of the balance for fast reads (UI, cheap pre-checks).
 * It is never authoritative — it's refreshed from Postgres after every write
 * and can be rebuilt at any time via `syncMirror`.
 *
 * Rollover policy is config-driven per plan:
 *   target = min(balance + allowance, max(rolloverCap, balance))
 *   - rolloverCap == allowance     -> burn-down (no carry-over)
 *   - rolloverCap >  allowance     -> carry-forward up to the cap
 * Already-purchased credits above the cap are never clawed back by a refill.
 */

const balanceKey = (userId: string) => `credits:balance:${userId}`;
const MIRROR_TTL_SEC = 3600;

async function setMirror(userId: string, balance: number) {
  await redis.set(balanceKey(userId), balance, "EX", MIRROR_TTL_SEC);
}

export async function syncMirror(userId: string): Promise<number> {
  const row = await prisma.creditBalance.findUnique({ where: { userId } });
  const balance = row?.balance ?? 0;
  await setMirror(userId, balance);
  return balance;
}

export async function getBalance(userId: string): Promise<number> {
  const cached = await redis.get(balanceKey(userId));
  if (cached !== null) return Number(cached);
  return syncMirror(userId);
}

/**
 * Used at provisioning and on plan change to keep refill config on the balance
 * row. On an upgrade (dailyAllowance increases) we also clear
 * `lastDailyRefillOn` so the next hourly cron sweep tops the user up to the
 * new tier instead of skipping them because the old-tier refill already ran
 * today. Trade-off: the user waits at most one cron tick (~1h) instead of up
 * to 24h, and we don't synchronously grant here to keep this call cheap and
 * to avoid double-granting if the webhook fires twice. Downgrades intentionally
 * keep the existing refill marker so the user can't grind a fresh allowance
 * by toggling plans.
 */
export async function setPlanCredits(opts: {
  userId: string;
  dailyAllowance: number;
  rolloverCap: number;
}): Promise<void> {
  const existing = await prisma.creditBalance.findUnique({
    where: { userId: opts.userId },
    select: { dailyAllowance: true },
  });
  const isUpgrade =
    existing != null && opts.dailyAllowance > existing.dailyAllowance;

  await prisma.creditBalance.upsert({
    where: { userId: opts.userId },
    create: {
      userId: opts.userId,
      balance: 0,
      dailyAllowance: opts.dailyAllowance,
      rolloverCap: opts.rolloverCap,
    },
    update: {
      dailyAllowance: opts.dailyAllowance,
      rolloverCap: opts.rolloverCap,
      ...(isUpgrade ? { lastDailyRefillOn: null } : {}),
    },
  });
}

type BalanceRow = {
  balance: number;
  dailyAllowance: number;
  rolloverCap: number;
  lastDailyRefillOn: string | null;
};

async function lockBalance(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<BalanceRow> {
  // Ensure the row exists, then lock it for the duration of the transaction.
  await tx.creditBalance.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT balance, "dailyAllowance", "rolloverCap", "lastDailyRefillOn"
    FROM "CreditBalance"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  return rows[0]!;
}

export type GrantResult = { balance: number; applied: boolean; delta: number };

/**
 * Idempotently add credits. `applied: false` means this idempotencyKey was
 * already processed (a no-op retry). If `rolloverCap` is passed the resulting
 * balance is clamped per the policy above.
 */
export async function grantCredits(opts: {
  userId: string;
  amount: number;
  reason: LedgerReason;
  idempotencyKey: string;
  rolloverCap?: number;
  metadata?: Prisma.InputJsonValue;
}): Promise<GrantResult> {
  const result = await prisma.$transaction(async (tx) => {
    const cb = await lockBalance(tx, opts.userId);

    const existing = await tx.creditLedger.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
    });
    if (existing) return { balance: cb.balance, applied: false, delta: 0 };

    const target =
      opts.rolloverCap != null
        ? Math.min(
            cb.balance + opts.amount,
            Math.max(opts.rolloverCap, cb.balance),
          )
        : cb.balance + opts.amount;
    const delta = target - cb.balance;

    await tx.creditBalance.update({
      where: { userId: opts.userId },
      data: { balance: target },
    });
    await tx.creditLedger.create({
      data: {
        userId: opts.userId,
        delta,
        balanceAfter: target,
        reason: opts.reason,
        idempotencyKey: opts.idempotencyKey,
        metadata: opts.metadata,
      },
    });
    return { balance: target, applied: true, delta };
  });

  await setMirror(opts.userId, result.balance);
  return result;
}

export type ConsumeResult = {
  ok: boolean;
  balance: number;
  applied: boolean;
};

/**
 * Idempotently spend credits. Returns `ok: false` (without mutating) when the
 * balance is insufficient. A repeated idempotencyKey (e.g. a retried job
 * submit) returns `ok: true, applied: false` so the caller treats it as the
 * same single spend.
 */
export async function consumeCredits(opts: {
  userId: string;
  amount: number;
  idempotencyKey: string;
  reason?: LedgerReason;
  metadata?: Prisma.InputJsonValue;
}): Promise<ConsumeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const cb = await lockBalance(tx, opts.userId);

    const existing = await tx.creditLedger.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
    });
    if (existing) return { ok: true, balance: cb.balance, applied: false };

    if (cb.balance < opts.amount) {
      return { ok: false, balance: cb.balance, applied: false };
    }

    const target = cb.balance - opts.amount;
    await tx.creditBalance.update({
      where: { userId: opts.userId },
      data: { balance: target },
    });
    await tx.creditLedger.create({
      data: {
        userId: opts.userId,
        delta: -opts.amount,
        balanceAfter: target,
        reason: opts.reason ?? LedgerReason.CONSUME,
        idempotencyKey: opts.idempotencyKey,
        metadata: opts.metadata,
      },
    });
    return { ok: true, balance: target, applied: true };
  });

  await setMirror(opts.userId, result.balance);
  return result;
}

/**
 * Claw back credits on refund/chargeback. Clamps at zero (we don't push a user
 * negative if they've already spent the refunded credits).
 */
export async function reverseCredits(opts: {
  userId: string;
  amount: number;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<GrantResult> {
  const result = await prisma.$transaction(async (tx) => {
    const cb = await lockBalance(tx, opts.userId);
    const existing = await tx.creditLedger.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
    });
    if (existing) return { balance: cb.balance, applied: false, delta: 0 };

    const target = Math.max(0, cb.balance - opts.amount);
    const delta = target - cb.balance;
    await tx.creditBalance.update({
      where: { userId: opts.userId },
      data: { balance: target },
    });
    await tx.creditLedger.create({
      data: {
        userId: opts.userId,
        delta,
        balanceAfter: target,
        reason: LedgerReason.REFUND_REVERSAL,
        idempotencyKey: opts.idempotencyKey,
        metadata: opts.metadata,
      },
    });
    return { balance: target, applied: true, delta };
  });

  await setMirror(opts.userId, result.balance);
  return result;
}

export type RefillResult = {
  refilled: boolean;
  balance: number;
  delta: number;
};

/**
 * Daily refill for one user, resolved against the user's *local* calendar day.
 *
 * The cron runs hourly (see refillJob.ts). For each user we compute the current
 * day in their IANA timezone and refill only if their local day has advanced
 * since `lastDailyRefillOn`. That solves the "00:00 UTC vs. local wall-clock"
 * problem without per-timezone cron fan-out, and the `daily:<user>:<localDay>`
 * idempotency key makes a re-run within the same local day a no-op.
 */
export async function refillDailyForUser(user: {
  id: string;
  timezone: string | null;
}): Promise<RefillResult> {
  const zone = user.timezone || "UTC";
  const nowLocal = DateTime.now().setZone(zone);
  const localDay = (nowLocal.isValid ? nowLocal : DateTime.utc()).toFormat(
    "yyyy-LL-dd",
  );
  const idempotencyKey = `daily:${user.id}:${localDay}`;

  const result = await prisma.$transaction(async (tx) => {
    const cb = await lockBalance(tx, user.id);
    if (cb.lastDailyRefillOn === localDay) {
      return { refilled: false, balance: cb.balance, delta: 0 };
    }

    // Refill policy:
    //   - Always grant the full daily allowance on top of the current balance.
    //   - Cap the result at max(rolloverCap, balance) so users who are already
    //     above the cap (e.g. via a large monthly grant) keep their overage but
    //     don't carry extra credits from the daily top-up beyond that cap.
    //
    //   new_balance = max(balance, min(balance + allowance, max(rolloverCap, balance)))
    //
    // Concretely:
    //   balance=5,  cap=50, allowance=10 -> 15  (normal case)
    //   balance=45, cap=50, allowance=10 -> 50  (capped at rolloverCap)
    //   balance=60, cap=50, allowance=10 -> 60  (overage preserved; no extra granted)
    //
    // The old formula used Math.min(balance+allowance, Math.max(cap, balance))
    // which silently zeroed the delta whenever balance > cap (overage case).
    const cap = Math.max(cb.rolloverCap, cb.balance);
    const target = Math.min(cb.balance + cb.dailyAllowance, cap);
    const delta = target - cb.balance;

    await tx.creditBalance.update({
      where: { userId: user.id },
      data: { balance: target, lastDailyRefillOn: localDay },
    });
    await tx.creditLedger.create({
      data: {
        userId: user.id,
        delta,
        balanceAfter: target,
        reason: LedgerReason.DAILY_REFILL,
        idempotencyKey,
        metadata: { localDay, zone },
      },
    });
    return { refilled: true, balance: target, delta };
  });

  await setMirror(user.id, result.balance);
  return result;
}

/**
 * Period (monthly) grant driven by `invoice.payment_succeeded`. Idempotent on
 * the billing-period anchor so Stripe retrying the invoice webhook can't double
 * grant. Also stamps `lastMonthlyGrantPeriod` for reconciliation.
 */
export async function grantMonthlyCredits(opts: {
  userId: string;
  amount: number;
  periodAnchor: string; // e.g. ISO of current_period_start
  rolloverCap?: number;
}): Promise<GrantResult> {
  const res = await grantCredits({
    userId: opts.userId,
    amount: opts.amount,
    reason: LedgerReason.MONTHLY_GRANT,
    idempotencyKey: `monthly:${opts.userId}:${opts.periodAnchor}`,
    rolloverCap: opts.rolloverCap,
    metadata: { periodAnchor: opts.periodAnchor },
  });
  if (res.applied) {
    await prisma.creditBalance.update({
      where: { userId: opts.userId },
      data: { lastMonthlyGrantPeriod: opts.periodAnchor },
    });
  }
  return res;
}
