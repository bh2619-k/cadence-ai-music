import { httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import { type AppRouter } from "@/server/routers/_app";

function getBaseUrl() {
  if (typeof window !== "undefined") return ""; // browser: relative
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export const trpc = createTRPCNext<AppRouter>({
  config() {
    return {
      transformer: superjson,
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        httpBatchLink({ url: `${getBaseUrl()}/api/trpc` }),
      ],
      queryClientConfig: {
        defaultOptions: {
          queries: { staleTime: 5_000, retry: 1 },
          // Mutations must not retry by default. Several mutations (createCheckout,
          // changePlan) are non-idempotent: react-query's default retry=3 would
          // spawn up to 3 duplicate Stripe Checkout Sessions on a transient error.
          mutations: { retry: false },
        },
      },
    };
  },
  ssr: false,
});

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
