import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/context";
import { captureException } from "@/lib/sentry";

export default createNextApiHandler({
  router: appRouter,
  createContext,
  onError({ error, path }) {
    // Only surface true server faults to Sentry; client errors (UNAUTHORIZED,
    // BAD_REQUEST, TOO_MANY_REQUESTS, ...) are expected and noisy.
    if (error.code === "INTERNAL_SERVER_ERROR") {
      captureException(error, { path: path ?? "<no-path>" });
    }
  },
});
