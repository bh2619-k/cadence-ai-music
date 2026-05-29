import { PrismaClient, PlanTier } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Seeds the three plans. Stripe price ids come from env so the same seed works
 * across test/live modes. Credit economics here are what the app reads at
 * provisioning and on plan change.
 */
async function main() {
  await prisma.plan.upsert({
    where: { tier: PlanTier.FREE },
    update: { name: "Free", dailyRefill: 10, rolloverCap: 10 },
    create: {
      tier: PlanTier.FREE,
      name: "Free",
      monthlyCredits: 0,
      dailyRefill: 10,
      rolloverCap: 10,
      priceCents: 0,
    },
  });

  await prisma.plan.upsert({
    where: { tier: PlanTier.PRO },
    update: {
      name: "Pro",
      monthlyCredits: 300,
      dailyRefill: 100,
      rolloverCap: 300,
      ...(process.env.STRIPE_PRICE_PRO_MONTHLY
        ? { stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY }
        : {}),
    },
    create: {
      tier: PlanTier.PRO,
      name: "Pro",
      monthlyCredits: 300,
      dailyRefill: 100,
      rolloverCap: 300,
      priceCents: 1200,
      ...(process.env.STRIPE_PRICE_PRO_MONTHLY
        ? { stripePriceIdMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY }
        : {}),
    },
  });

  await prisma.plan.upsert({
    where: { tier: PlanTier.STUDIO },
    update: {
      name: "Studio",
      monthlyCredits: 1500,
      dailyRefill: 500,
      rolloverCap: 1500,
      ...(process.env.STRIPE_PRICE_STUDIO_MONTHLY
        ? { stripePriceIdMonthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY }
        : {}),
    },
    create: {
      tier: PlanTier.STUDIO,
      name: "Studio",
      monthlyCredits: 1500,
      dailyRefill: 500,
      rolloverCap: 1500,
      priceCents: 3900,
      ...(process.env.STRIPE_PRICE_STUDIO_MONTHLY
        ? { stripePriceIdMonthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY }
        : {}),
    },
  });

  console.log("Seeded plans: FREE, PRO, STUDIO");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
