-- ===========================================================================
-- Historical migration: Paddle -> Stripe (schema side)
-- ===========================================================================
-- This is the production schema migration that introduced Stripe alongside
-- Paddle so the two providers could run in parallel during the subscriber
-- cutover (the data cutover itself is in
-- apps/web/src/server/billing/migration/paddleToStripe.ts).
--
-- It is kept here as documentation. In this reference repo the Prisma baseline
-- (prisma/migrations/0001_init) is squashed to the post-migration schema, which
-- is standard once a migration has fully shipped. The intent of preserving it:
-- show the dual-write + backfill + default-flip pattern used to add a second
-- billing provider with zero downtime.
--
-- Key ideas:
--   * Add Stripe columns as NULLable next to the existing Paddle columns — no
--     rewrite of live rows, no lock contention on a large table.
--   * Backfill `provider = 'PADDLE'` for everything that exists today, THEN flip
--     the column default to 'STRIPE' so new subscriptions are Stripe-native.
--   * Introduce the webhook idempotency table that both providers write to.
-- ===========================================================================

BEGIN;

-- 1) New enum for the provider discriminator.
CREATE TYPE "BillingProvider" AS ENUM ('PADDLE', 'STRIPE');

-- 2) Provider column. Default to PADDLE *for the backfill window* so existing
--    rows are correctly labelled without an explicit UPDATE of every row.
ALTER TABLE "Subscription"
  ADD COLUMN "provider" "BillingProvider" NOT NULL DEFAULT 'PADDLE';

-- 3) Stripe identifiers, NULLable (Paddle-era rows won't have them yet).
ALTER TABLE "Subscription"
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "stripeCustomerId"     TEXT;

ALTER TABLE "User"
  ADD COLUMN "stripeCustomerId" TEXT;

-- 4) Belt-and-suspenders backfill (the default already covers existing rows;
--    explicit so intent is obvious and re-runs are safe).
UPDATE "Subscription" SET "provider" = 'PADDLE' WHERE "provider" IS NULL;

-- 5) Now that existing rows are labelled, make Stripe the default for all new
--    subscriptions created by the app going forward.
ALTER TABLE "Subscription" ALTER COLUMN "provider" SET DEFAULT 'STRIPE';

-- 6) Uniqueness on the new external ids (NULLs allowed -> many Paddle rows OK).
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key"
  ON "Subscription" ("stripeSubscriptionId");
CREATE UNIQUE INDEX "User_stripeCustomerId_key"
  ON "User" ("stripeCustomerId");

-- 7) Helpful read paths for reconciliation / cutover batches.
CREATE INDEX "Subscription_provider_status_idx"
  ON "Subscription" ("provider", "status");

-- 8) Webhook idempotency ledger (shared by Paddle + Stripe ingest). PK = the
--    provider's event id, which is the natural dedupe key.
CREATE TABLE "WebhookEvent" (
  "id"          TEXT NOT NULL,
  "provider"    "BillingProvider" NOT NULL,
  "type"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'processing',
  "payloadHash" TEXT,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "error"       TEXT,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookEvent_type_idx" ON "WebhookEvent" ("type");
CREATE INDEX "WebhookEvent_status_receivedAt_idx"
  ON "WebhookEvent" ("status", "receivedAt");

COMMIT;

-- Post-migration sanity check (run separately):
--   SELECT provider, count(*) FROM "Subscription" GROUP BY provider;
--   -- expect: PADDLE = <all pre-existing>, STRIPE = 0 until the data cutover runs.
