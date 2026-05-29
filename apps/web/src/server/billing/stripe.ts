import Stripe from "stripe";
import { prisma } from "@cadence/db";
import { env } from "@/env";

// Pin the API version Cadence is built against. `satisfies` makes an SDK bump
// that changes the pinned version a compile error rather than a runtime surprise.
export const STRIPE_API_VERSION = "2024-06-20" satisfies Stripe.LatestApiVersion;

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
  typescript: true,
  appInfo: { name: "Cadence", version: "0.1.0" },
});

export type PaidTier = "PRO" | "STUDIO";

export function priceIdForTier(tier: PaidTier): string {
  const id =
    tier === "PRO"
      ? env.STRIPE_PRICE_PRO_MONTHLY
      : env.STRIPE_PRICE_STUDIO_MONTHLY;
  if (!id) throw new Error(`No Stripe price configured for tier ${tier}`);
  return id;
}

/**
 * Ensure the user has a Stripe customer. The idempotency key keys customer
 * creation to the user id, so two concurrent checkout clicks can't create two
 * customers for the same account.
 */
export async function getOrCreateCustomer(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { stripeCustomerId: true, email: true, name: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await stripe.customers.create(
    {
      email: existing?.email ?? user.email ?? undefined,
      name: existing?.name ?? user.name ?? undefined,
      metadata: { userId: user.id },
    },
    { idempotencyKey: `customer:${user.id}` },
  );

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

/**
 * Subscription Checkout with Stripe Tax. `automatic_tax` + `customer_update`
 * address/name + `tax_id_collection` are what Stripe requires to compute and
 * collect EU/UK VAT correctly at checkout.
 */
export async function createCheckoutSession(opts: {
  user: { id: string; email?: string | null; name?: string | null };
  tier: PaidTier;
  successUrl: string;
  cancelUrl: string;
}): Promise<Stripe.Checkout.Session> {
  const customerId = await getOrCreateCustomer(opts.user);
  return stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: opts.user.id,
    line_items: [{ price: priceIdForTier(opts.tier), quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    billing_address_collection: "auto",
    metadata: { userId: opts.user.id, tier: opts.tier },
    subscription_data: {
      metadata: { userId: opts.user.id, tier: opts.tier },
    },
  });
}

export async function createBillingPortalSession(opts: {
  customerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  return stripe.billingPortal.sessions.create({
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
}

/**
 * Plan change (upgrade/downgrade) with proration. Reuses the existing
 * subscription item so Stripe prorates the difference; idempotency-keyed on the
 * (subscription, target price) pair.
 */
export async function changeSubscriptionPlan(opts: {
  subscriptionId: string;
  newPriceId: string;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
}): Promise<Stripe.Subscription> {
  const sub = await stripe.subscriptions.retrieve(opts.subscriptionId);
  const itemId = sub.items.data[0]?.id;
  if (!itemId) throw new Error("Subscription has no items to update");

  return stripe.subscriptions.update(
    opts.subscriptionId,
    {
      items: [{ id: itemId, price: opts.newPriceId }],
      proration_behavior: opts.prorationBehavior ?? "create_prorations",
      payment_behavior: "pending_if_incomplete",
    },
    { idempotencyKey: `planchange:${opts.subscriptionId}:${opts.newPriceId}` },
  );
}
