import type { NextApiRequest, NextApiResponse } from "next";
import { runDailyRefillSweep } from "@/server/credits/refillJob";
import { env } from "@/env";
import { captureException } from "@/lib/sentry";

/**
 * Hourly Vercel cron (see vercel.json). Runs the timezone-aware daily refill
 * sweep. Protected by CRON_SECRET so it can't be triggered by the public.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (
    env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const summary = await runDailyRefillSweep();
    // skipped: true means another invocation already holds the lock — not an
    // error, but worth surfacing in Vercel logs for ops visibility.
    return res.status(200).json(summary);
  } catch (err) {
    captureException(err, { scope: "cron-refill" });
    return res.status(500).json({ error: "refill sweep failed" });
  }
}
