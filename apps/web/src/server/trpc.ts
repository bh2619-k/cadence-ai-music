import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { type Context } from "@/server/context";
import { rateLimit } from "@/server/ratelimit/rateLimiter";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

const enforceAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    // Narrow the type so downstream procedures get a non-null session.
    ctx: { ...ctx, session: { ...ctx.session, user: ctx.session.user } },
  });
});

export const protectedProcedure = t.procedure.use(enforceAuth);

/**
 * Per-procedure rate limit, keyed by user id (falls back to IP for anon).
 * Sliding-window via Redis — see rateLimiter.ts.
 */
export function rateLimited(opts: { limit: number; windowSec: number }) {
  return t.middleware(async ({ ctx, path, next }) => {
    const identity = ctx.session?.user?.id ?? ctx.ip ?? "anon";
    const result = await rateLimit({
      key: `rl:trpc:${path}:${identity}`,
      limit: opts.limit,
      windowSec: opts.windowSec,
    });
    if (!result.success) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded. Try again in ${result.retryAfterSec}s.`,
      });
    }
    return next();
  });
}
