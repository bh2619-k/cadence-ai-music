import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { getBalance } from "@/server/credits/creditService";

export const creditsRouter = createTRPCRouter({
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const balance = await getBalance(ctx.session.user.id);
    const config = await ctx.prisma.creditBalance.findUnique({
      where: { userId: ctx.session.user.id },
      select: { dailyAllowance: true, rolloverCap: true, lastDailyRefillOn: true },
    });
    return {
      balance,
      dailyAllowance: config?.dailyAllowance ?? 0,
      rolloverCap: config?.rolloverCap ?? 0,
      lastDailyRefillOn: config?.lastDailyRefillOn ?? null,
    };
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.creditLedger.findMany({
        where: { userId: ctx.session.user.id },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: {
          id: true,
          delta: true,
          balanceAfter: true,
          reason: true,
          createdAt: true,
        },
      });
    }),
});
