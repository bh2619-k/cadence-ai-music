import { PostHog } from "posthog-node";
import { env } from "@/env";

/**
 * Server-side PostHog. Used for feature-flag gating of paywall experiments and
 * for funnel events that must be trustworthy (can't be blocked client-side).
 * No-ops cleanly when POSTHOG_KEY is unset (local dev).
 */
let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!env.POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(env.POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // Serverless: flush every event immediately, don't rely on a long-lived
      // process to drain the queue.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

export async function isFeatureEnabled(
  flag: string,
  distinctId: string,
  fallback = false,
): Promise<boolean> {
  const c = getClient();
  if (!c) return fallback;
  try {
    return (await c.isFeatureEnabled(flag, distinctId)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function captureServer(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  getClient()?.capture({ distinctId, event, properties });
}
