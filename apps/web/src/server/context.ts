import { type CreateNextContextOptions } from "@trpc/server/adapters/next";
import { type inferAsyncReturnType } from "@trpc/server";
import type { IncomingMessage } from "http";
import { prisma } from "@cadence/db";
import { redis } from "@/server/redis";
import { getServerAuthSession } from "@/server/auth";

function getClientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.socket?.remoteAddress ?? "0.0.0.0";
}

/**
 * Built once per tRPC request. Everything downstream (procedures, middleware)
 * reads session/prisma/redis/ip from here.
 */
export async function createContext(opts: CreateNextContextOptions) {
  const { req, res } = opts;
  const session = await getServerAuthSession({ req, res });
  return {
    session,
    prisma,
    redis,
    req,
    res,
    ip: getClientIp(req),
  };
}

export type Context = inferAsyncReturnType<typeof createContext>;
