import { randomUUID } from "crypto";
import { redis } from "@/server/redis";

/**
 * Sliding-window-log rate limiter.
 *
 * The whole check-and-increment runs as one Lua script so it's atomic across
 * concurrent requests (no read-modify-write race that a naive INCR/EXPIRE pair
 * would have). Each request is a member in a sorted set scored by timestamp;
 * we evict anything older than the window, count what's left, and either admit
 * (adding a member) or reject (reporting when the oldest entry expires).
 */
const SLIDING_WINDOW = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, oldest[2]}
`;

export type RateLimitResult = {
  success: boolean;
  remaining: number;
  retryAfterSec: number;
};

export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = opts.windowSec * 1000;
  const member = `${now}:${randomUUID()}`;

  const [ok, remaining, oldestScore] = (await redis.eval(
    SLIDING_WINDOW,
    1,
    opts.key,
    String(now),
    String(windowMs),
    String(opts.limit),
    member,
  )) as [number, number, string | number];

  if (ok === 1) {
    return { success: true, remaining: Number(remaining), retryAfterSec: 0 };
  }

  const oldest = Number(oldestScore) || now;
  const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
  return { success: false, remaining: 0, retryAfterSec };
}
