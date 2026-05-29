import { prisma } from "@cadence/db";
import { stripe } from "@/server/billing/stripe";
import {
  upsertSubscriptionFromStripe,
  mapStripeStatus,
} from "@/server/billing/subscriptionState";

/**
 * Drift reconciliation: webhooks are the primary sync path, but events get
 * dropped, reordered, or fail. This walks every Stripe-backed subscription,
 * compares our row to the live Stripe object, logs drift, and (with --apply)
 * repairs it through the same single write path the webhooks use.
 *
 *   yarn workspace web reconcile           # dry run, report only
 *   yarn workspace web reconcile --apply   # fix drift
 */
export type ReconcileSummary = {
  checked: number;
  drifted: number;
  fixed: number;
  errors: number;
};

export async function reconcileSubscriptions(opts: {
  apply: boolean;
}): Promise<ReconcileSummary> {
  const subs = await prisma.subscription.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: {
      id: true,
      userId: true,
      status: true,
      currentPeriodEnd: true,
      stripeSubscriptionId: true,
    },
  });

  const summary: ReconcileSummary = {
    checked: 0,
    drifted: 0,
    fixed: 0,
    errors: 0,
  };

  for (const sub of subs) {
    summary.checked++;
    try {
      const remote = await stripe.subscriptions.retrieve(
        sub.stripeSubscriptionId!,
      );
      const remoteStatus = mapStripeStatus(remote.status);
      const remoteEnd = remote.current_period_end
        ? new Date(remote.current_period_end * 1000)
        : null;

      const statusDrift = remoteStatus !== sub.status;
      const periodDrift =
        (remoteEnd?.getTime() ?? 0) !== (sub.currentPeriodEnd?.getTime() ?? 0);

      if (statusDrift || periodDrift) {
        summary.drifted++;
        console.log(
          `[drift] user=${sub.userId} db=${sub.status}/${sub.currentPeriodEnd?.toISOString()} ` +
            `stripe=${remoteStatus}/${remoteEnd?.toISOString()}`,
        );
        if (opts.apply) {
          await upsertSubscriptionFromStripe(remote);
          summary.fixed++;
        }
      }
    } catch (err) {
      summary.errors++;
      console.error(`[error] subscription=${sub.id}`, err);
    }
  }

  return summary;
}

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  reconcileSubscriptions({ apply })
    .then((summary) => {
      console.log(apply ? "RECONCILE (applied)" : "RECONCILE (dry-run)", summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
