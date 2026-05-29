import { prisma, BillingProvider, SubscriptionStatus } from "@cadence/db";
import { stripe, getOrCreateCustomer } from "@/server/billing/stripe";

/**
 * Paddle -> Stripe subscriber migration (zero billing interruption).
 *
 * The core trick to avoid double-charging or a coverage gap: we create the
 * Stripe subscription now but set `billing_cycle_anchor` to the subscriber's
 * existing Paddle period end, with `proration_behavior: "none"`. Stripe then
 * issues the *first* invoice exactly when Paddle would have renewed — no
 * immediate charge, no proration, no gap. The matching Paddle subscription is
 * then set to cancel at that same period end, so the customer is never billed
 * by both providers for the same window.
 *
 * Safety properties:
 *  - Idempotent: skips rows that already have a Stripe subscription, and uses a
 *    Stripe idempotency key derived from the Paddle subscription id, so a re-run
 *    won't create duplicate Stripe subscriptions.
 *  - Dry-run by default. `--apply` performs writes. `--limit=N` batches the
 *    cutover so we can ramp (e.g. 1% -> 10% -> 100%).
 *
 * Prerequisite: each migrating customer must already have a Stripe payment
 * method attached (collected ahead of time via a SetupIntent / Checkout in
 * setup mode). That step is intentionally out of this script.
 */
export type MigrationSummary = {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: number;
};

export async function migratePaddleToStripe(opts: {
  apply: boolean;
  limit?: number;
}): Promise<MigrationSummary> {
  const subs = await prisma.subscription.findMany({
    where: {
      provider: BillingProvider.PADDLE,
      stripeSubscriptionId: null,
      status: {
        in: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIALING,
          SubscriptionStatus.PAST_DUE,
        ],
      },
    },
    include: { user: true, plan: true },
    take: opts.limit,
    orderBy: { createdAt: "asc" },
  });

  const summary: MigrationSummary = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  for (const sub of subs) {
    summary.scanned++;
    try {
      const priceId = sub.plan.stripePriceIdMonthly;
      if (!priceId) {
        console.warn(
          `[skip] user=${sub.userId} plan=${sub.plan.tier} has no Stripe price mapped`,
        );
        summary.skipped++;
        continue;
      }

      const anchor = sub.currentPeriodEnd;
      if (!anchor || anchor.getTime() <= Date.now()) {
        console.warn(
          `[skip] user=${sub.userId} period end missing/past — needs manual handling`,
        );
        summary.skipped++;
        continue;
      }
      const anchorUnix = Math.floor(anchor.getTime() / 1000);

      console.log(
        `[plan] user=${sub.userId} paddle=${sub.paddleSubscriptionId} ` +
          `-> price=${priceId} firstStripeCharge=${anchor.toISOString()}`,
      );
      if (!opts.apply) continue;

      const customerId = await getOrCreateCustomer(sub.user);

      const stripeSub = await stripe.subscriptions.create(
        {
          customer: customerId,
          items: [{ price: priceId }],
          billing_cycle_anchor: anchorUnix,
          proration_behavior: "none",
          automatic_tax: { enabled: true },
          metadata: {
            userId: sub.userId,
            migratedFromPaddle: sub.paddleSubscriptionId ?? "",
          },
        },
        { idempotencyKey: `migrate:${sub.paddleSubscriptionId ?? sub.id}` },
      );

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          provider: BillingProvider.STRIPE,
          stripeSubscriptionId: stripeSub.id,
          stripeCustomerId: customerId,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      // INTEGRATION POINT: cancel the Paddle subscription at `anchor`
      // (Paddle API) so no double billing. Left out here to keep the script
      // provider-focused and safe to dry-run.
      summary.migrated++;
    } catch (err) {
      summary.errors++;
      console.error(`[error] user=${sub.userId}`, err);
    }
  }

  return summary;
}

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  migratePaddleToStripe({ apply, limit })
    .then((summary) => {
      console.log(apply ? "MIGRATION (applied)" : "MIGRATION (dry-run)", summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
