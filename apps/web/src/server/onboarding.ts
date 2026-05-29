import { prisma, PlanTier, LedgerReason } from "@cadence/db";
import { setPlanCredits, grantCredits } from "@/server/credits/creditService";

const FREE_DEFAULTS = { dailyRefill: 10, rolloverCap: 10 };

/**
 * First-login provisioning. Called from NextAuth's `createUser` event.
 * Idempotent: returns early if the user already has a balance row, so a
 * replayed event or a re-run can't double-grant signup credits.
 */
export async function provisionNewUser(userId: string): Promise<void> {
  const existing = await prisma.creditBalance.findUnique({ where: { userId } });
  if (existing) return;

  const free = await prisma.plan.findUnique({ where: { tier: PlanTier.FREE } });
  const dailyAllowance = free?.dailyRefill ?? FREE_DEFAULTS.dailyRefill;
  const rolloverCap = free?.rolloverCap ?? FREE_DEFAULTS.rolloverCap;

  await setPlanCredits({ userId, dailyAllowance, rolloverCap });
  await grantCredits({
    userId,
    amount: dailyAllowance,
    reason: LedgerReason.SIGNUP_GRANT,
    idempotencyKey: `signup:${userId}`,
    rolloverCap,
  });
}
