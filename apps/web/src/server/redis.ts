import Redis from "ioredis";
import { env } from "@/env";

/**
 * Single shared ioredis connection. Reused across hot-reloads in dev so we
 * don't leak connections, and across lambda invocations in prod (Vercel keeps
 * the module warm between requests on the same instance).
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    // Don't block module init if Redis is briefly unreachable; commands queue.
    lazyConnect: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
