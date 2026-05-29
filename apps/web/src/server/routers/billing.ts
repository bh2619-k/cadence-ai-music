import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import {
  createCheckoutSession,
  createBillingPortalSession,
  changeSubscriptionPlan,
  getOrCreateCustomer,
  priceIdForTier,
} from "@/server/billing/stripe";
import { env } from "@/env";

const tierInput = z.object({ tier: z.enum(["PRO", "STUDIO"]) });

function baseUrl(host?: string): string {
  return env.NEXTAUTH_URL ?? (host ? `https://${host}` : "http://localhost:3000");
}

export const billingRouter = createTRPCRouter({
  getSubscription: protectedProcedure.query(async ({ ctx }) => {
    const sub = await ctx.prisma.subscription.findUnique({
      where: { userId: ctx.session.user.id },
      include: { plan: true },
    });
    return sub;
  }),

  createCheckout: protectedProcedure
    .input(tierInput)
    .mutation(async ({ ctx, input }) => {
      const origin = baseUrl(ctx.req.headers.host);
      const session = await createCheckoutSession({
        user: ctx.session.user,
        tier: input.tier,
        successUrl: `${origin}/billing?success=1`,
        cancelUrl: `${origin}/pricing?canceled=1`,
      });
      if (!session.url) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe did not return a checkout URL",
        });
      }
      return { url: session.url };
    }),

  createPortal: protectedProcedure.mutation(async ({ ctx }) => {
    const customerId = await getOrCreateCustomer(ctx.session.user);
    const origin = baseUrl(ctx.req.headers.host);
    const session = await createBillingPortalSession({
      customerId,
      returnUrl: `${origin}/billing`,
    });
    return { url: session.url };
  }),

  changePlan: protectedProcedure
    .input(tierInput)
    .mutation(async ({ ctx, input }) => {
      const sub = await ctx.prisma.subscription.findUnique({
        where: { userId: ctx.session.user.id },
      });
      if (!sub?.stripeSubscriptionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active Stripe subscription to change",
        });
      }
      const updated = await changeSubscriptionPlan({
        subscriptionId: sub.stripeSubscriptionId,
        newPriceId: priceIdForTier(input.tier),
      });
      // The customer.subscription.updated webhook will persist the new state;
      // we just report the resulting status to the caller.
      return { status: updated.status };
    }),
});
