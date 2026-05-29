import * as Sentry from "@sentry/nextjs";
import { env } from "@/env";

/**
 * Thin wrapper so call sites don't need to null-check the DSN. If Sentry isn't
 * configured (local dev), these degrade to console logging.
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
) {
  if (env.SENTRY_DSN) {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } else {
    console.error("[sentry:dev]", err, context ?? "");
  }
}

export function captureMessage(message: string, context?: Record<string, unknown>) {
  if (env.SENTRY_DSN) {
    Sentry.captureMessage(message, { extra: context });
  } else {
    console.warn("[sentry:dev]", message, context ?? "");
  }
}
