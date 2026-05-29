import { createTRPCRouter } from "@/server/trpc";
import { billingRouter } from "@/server/routers/billing";
import { creditsRouter } from "@/server/routers/credits";
import { assetsRouter } from "@/server/routers/assets";
import { studioRouter } from "@/server/routers/studio";

export const appRouter = createTRPCRouter({
  billing: billingRouter,
  credits: creditsRouter,
  assets: assetsRouter,
  studio: studioRouter,
});

export type AppRouter = typeof appRouter;
