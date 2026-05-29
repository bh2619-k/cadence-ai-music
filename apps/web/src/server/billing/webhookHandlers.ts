import type Stripe from "stripe";
import { prisma } from "@cadence/db";
import { stripe } from "@/server/billing/stripe";
import {
  upsertSubscriptionFromStripe,
  resolveUserId,
} from "@/server/billing/subscriptionState";
import {
  grantMonthlyCredits,
  reverseCredits,
} from "@/server/credits/creditService";
import { revokeAllPremiumAccess } from "@/server/assets/assetAccess";

/**
 * Pure business logic for each Stripe event. Idempotency at the transport layer
 * is handled in /api/webhooks/stripe.ts (the WebhookEvent claim); the effects
 * here are *also* individually idempotent (period-keyed grants, charge-keyed
 * reversals) so even a bug in the claim can't double-apply money or credits.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(
          session.subscription as string,
        );
        await upsertSubscriptionFromStripe(sub);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await upsertSubscriptionFromStripe(
        event.data.object as Stripe.Subscription,
      );
      break;
    }

    case "invoice.payment_succeeded": {
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        // subscription.updated will also reflect past_due, but syncing here
        // closes the gap if that event is delayed/reordered.
        const sub = await stripe.subscriptions.retrieve(
          invoice.subscription as string,
        );
        await upsertSubscriptionFromStripe(sub);
      }
      break;
    }

    case "charge.refunded": {
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    }

    default:
      // Acked and ignored — we only subscribe to the types above in the Stripe
      // dashboard, but defend against extras.
      break;
  }
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.subscription) return;
  // Only grant on the initial create and on each renewal cycle — not on
  // proration top-ups or manual one-offs.
  if (
    invoice.billing_reason &&
    !["subscription_create", "subscription_cycle"].includes(
      invoice.billing_reason,
    )
  ) {
    return;
  }

  const sub = await stripe.subscriptions.retrieve(
    invoice.subscription as string,
  );
  await upsertSubscriptionFromStripe(sub);

  const userId = await resolveUserId(sub);
  if (!userId) return;

  const priceId = sub.items.data[0]?.price.id;
  const plan = priceId
    ? await prisma.plan.findUnique({ where: { stripePriceIdMonthly: priceId } })
    : null;
  if (!plan || plan.monthlyCredits <= 0) return;

  // Period anchor makes the grant idempotent across Stripe's invoice retries.
  // Both timestamps are nullable in the Stripe type; guard before arithmetic to
  // avoid `new Date(NaN).toISOString()` throwing a RangeError.
  const anchorSeconds = sub.current_period_start ?? invoice.period_start;
  if (anchorSeconds == null) {
    // No billing period to anchor on — skip rather than risk a duplicate grant
    // or an unhandled exception that causes Stripe to retry forever.
    return;
  }
  const periodAnchor = new Date(anchorSeconds * 1000).toISOString();

  await grantMonthlyCredits({
    userId,
    amount: plan.monthlyCredits,
    periodAnchor,
    rolloverCap: Math.max(plan.rolloverCap, plan.monthlyCredits),
  });
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const cust =
    typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  if (!cust) return;

  const user = await prisma.user.findUnique({
    where: { stripeCustomerId: cust },
    select: { id: true },
  });
  if (!user) return;

  // Lock premium downloads (R2 access) without destroying the user's data.
  await revokeAllPremiumAccess(user.id, `refund:${charge.id}`);

  // If this charge sold a credit pack, claw those credits back (idempotent on
  // the charge id, clamped at zero).
  const creditsPurchased = Number(charge.metadata?.creditsPurchased ?? 0);
  if (creditsPurchased > 0) {
    await reverseCredits({
      userId: user.id,
      amount: creditsPurchased,
      idempotencyKey: `refund:${charge.id}`,
      metadata: { chargeId: charge.id, amountRefunded: charge.amount_refunded },
    });
  }
}
