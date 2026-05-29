import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

// Avoid exhausting Postgres connections on Next.js hot-reload in dev.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export the generated types/enums so app code imports everything from
// "@cadence/db" rather than reaching into @prisma/client directly.
export * from "@prisma/client";
export { Prisma } from "@prisma/client";
