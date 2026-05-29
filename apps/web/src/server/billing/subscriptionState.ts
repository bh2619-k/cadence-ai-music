import type Stripe from "stripe";
import { prisma, SubscriptionStatus, PlanTier } from "@cadence/db";
import { setPlanCredits } from "@/server/credits/creditService";
import { captureMessage } from "@/lib/sentry";

/**
 * Maps Stripe's subscription status to our enum 1:1. Keeping the enum aligned
 * with Stripe means the webhook path is a lookup, not a translation with edge
 * cases. Paddle statuses are normalized into the same enum on the legacy path.
 */
const STATUS_MAP: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
  trialing: SubscriptionStatus.TRIALING,
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELED,
  unpaid: SubscriptionStatus.UNPAID,
  incomplete: SubscriptionStatus.INCOMPLETE,
  incomplete_expired: SubscriptionStatus.INCOMPLETE_EXPIRED,
  paused: SubscriptionStatus.PAUSED,
};

export function mapStripeStatus(
  status: Stripe.Subscription.Status,
): SubscriptionStatus {
  return STATUS_MAP[status] ?? SubscriptionStatus.INCOMPLETE;
}

const toDate = (seconds: number | null | undefined): Date | null =>
  seconds == null ? null : new Date(seconds * 1000);

const customerId = (
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null => (typeof customer === "string" ? customer : customer?.id ?? null);

/** Prefer the userId we stamped in metadata; fall back to the customer mapping. */
export async function resolveUserId(
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromMeta = sub.metadata?.userId;
  if (fromMeta) return fromMeta;

  const cust = customerId(sub.customer);
  if (!cust) return null;
  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: cust },
    select: { id: true },
  });
  return user?.id ?? null;
}

const isLapsed = (status: SubscriptionStatus) =>
  status === SubscriptionStatus.CANCELED ||
  status === SubscriptionStatus.UNPAID ||
  status === SubscriptionStatus.INCOMPLETE_EXPIRED;

/**
 * The single write path for Stripe subscription state. Every subscription
 * webhook funnels through here so the DB is always a faithful projection of
 * Stripe — there's no second place that mutates subscription rows.
 */
export async function upsertSubscriptionFromStripe(
  sub: Stripe.Subscription,
): Promise<void> {
  const userId = await resolveUserId(sub);
  if (!userId) {
    captureMessage("Stripe subscription for unknown user", {
      subscriptionId: sub.id,
      customer: customerId(sub.customer),
    });
    return;
  }

  const priceId = sub.items.data[0]?.price.id ?? null;
  const plan = priceId
    ? await prisma.plan.findUnique({ where: { stripePriceIdMonthly: priceId } })
    : null;

  // FK fallback: if we can't resolve the price to a plan, anchor to FREE so the
  // row is still consistent, and flag it for follow-up.
  const freePlan = await prisma.plan.findUnique({
    where: { tier: PlanTier.FREE },
  });
  const resolvedPlan = plan ?? freePlan;
  if (!resolvedPlan) {
    captureMessage("No plan resolvable for Stripe subscription (seed missing?)", {
      subscriptionId: sub.id,
      priceId,
    });
    return;
  }
  if (!plan) {
    captureMessage("Stripe price not mapped to a plan", {
      subscriptionId: sub.id,
      priceId,
    });
  }

  const status = mapStripeStatus(sub.status);
  const data = {
    planId: resolvedPlan.id,
    provider: "STRIPE" as const,
    status,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: customerId(sub.customer),
    currentPeriodStart: toDate(sub.current_period_start),
    currentPeriodEnd: toDate(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: toDate(sub.canceled_at),
    trialEndsAt: toDate(sub.trial_end),
  };

  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  // Keep the credit refill config in lockstep with entitlement. On lapse we drop
  // the user back to FREE limits without deleting their remaining balance.
  if (isLapsed(status) && freePlan) {
    await setPlanCredits({
      userId,
      dailyAllowance: freePlan.dailyRefill,
      rolloverCap: freePlan.rolloverCap,
    });
  } else if (plan) {
    await setPlanCredits({
      userId,
      dailyAllowance: plan.dailyRefill,
      rolloverCap: plan.rolloverCap,
    });
  }
}
