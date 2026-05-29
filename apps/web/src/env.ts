import { z } from "zod";

/**
 * Server-side env validation. Fails fast at boot with a readable error instead
 * of surfacing `undefined` deep inside a Stripe/Redis call at runtime.
 * Set SKIP_ENV_VALIDATION=1 for `next build`/typecheck in CI without secrets.
 */
const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  NEXTAUTH_URL: z.string().url().optional(),
  NEXTAUTH_SECRET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_STUDIO_MONTHLY: z.string().optional(),

  REDIS_URL: z.string().url(),

  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default("cadence-assets"),
  R2_PUBLIC_BASE_URL: z.string().optional(),

  POSTHOG_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),

  MODAL_INFERENCE_URL: z.string().url().optional(),
  MODAL_TOKEN: z.string().optional(),

  // Shared secret guarding the Vercel cron endpoints.
  CRON_SECRET: z.string().optional(),
});

type ServerEnv = z.infer<typeof serverSchema>;

function buildEnv(): ServerEnv {
  if (process.env.SKIP_ENV_VALIDATION) {
    return process.env as unknown as ServerEnv;
  }
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      "❌ Invalid environment variables:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment variables");
  }
  return parsed.data;
}

export const env = buildEnv();
