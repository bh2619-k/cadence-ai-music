import { prisma } from "@cadence/db";
import { refillDailyForUser } from "@/server/credits/creditService";
import { redis } from "@/server/redis";
import { captureException } from "@/lib/sentry";

export type RefillSweepSummary = {
  scanned: number;
  refilled: number;
  errors: number;
  skipped?: true; // present when the lock was already held
};

// Vercel cron occasionally fires twice within the same tick (platform retries,
// duplicate deliveries). A Redis NX lock ensures only one sweep runs at a time.
// TTL is generous (90 min) so a crashed/long-running sweep doesn't block the
// next hourly tick forever.
const LOCK_KEY = "cron:daily-refill:lock";
const LOCK_TTL_SEC = 90 * 60;

/**
 * Sweeps all users and refills any whose local day has rolled over. Designed to
 * run hourly (Vercel cron -> /api/cron/refill). Paginates by id cursor so it
 * scales past the row limit, and isolates per-user failures so one bad row
 * doesn't abort the whole sweep. A distributed Redis lock prevents concurrent
 * executions from double-refilling users.
 */
export async function runDailyRefillSweep(opts?: {
  batchSize?: number;
}): Promise<RefillSweepSummary> {
  // SET lock NX EX <ttl> — returns "OK" if we got the lock, null if it was
  // already held by another invocation.
  const acquired = await redis.set(LOCK_KEY, "1", "EX", LOCK_TTL_SEC, "NX");
  if (acquired === null) {
    return { scanned: 0, refilled: 0, errors: 0, skipped: true };
  }

  const batchSize = opts?.batchSize ?? 500;
  let cursor: string | undefined;
  const summary: RefillSweepSummary = { scanned: 0, refilled: 0, errors: 0 };

  try {
    for (;;) {
      const users = await prisma.user.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, timezone: true },
      });
      if (users.length === 0) break;

      for (const user of users) {
        summary.scanned++;
        try {
          const res = await refillDailyForUser(user);
          if (res.refilled) summary.refilled++;
        } catch (err) {
          summary.errors++;
          captureException(err, { userId: user.id, job: "daily-refill" });
        }
      }

      cursor = users[users.length - 1]!.id;
      if (users.length < batchSize) break;
    }
  } finally {
    // Release the lock early so the next cron tick isn't forced to wait the
    // full TTL when the sweep finishes well before 90 minutes.
    await redis.del(LOCK_KEY);
  }

  return summary;
}
