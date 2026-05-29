# Cadence — AI Music SaaS

Reference implementation of a consumer AI-music PLG SaaS. Users generate music, separate audio stems, convert voices, and create music videos from text prompts. Credits are metered, plans are tiered, and billing runs through Stripe.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Monorepo Structure](#monorepo-structure)
- [Tech Stack](#tech-stack)
- [Features & Plans](#features--plans)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [Billing & Credits](#billing--credits)
- [Inference Pipeline](#inference-pipeline)
- [Deploying to Production](#deploying-to-production)

---

## Architecture Overview

```
Browser  ──► Next.js (tRPC)  ──► PostgreSQL (Prisma)
                │                    Redis (credit cache)
                │                    Cloudflare R2 (assets)
                │
                └──► Modal.com GPU ──► A10G inference
                          ▲
                    (async poll, not webhook)
```

The web app handles auth, billing, and job orchestration. GPU work runs on Modal serverless functions; the web app submits a job and gets a `call_id` back immediately, then polls for completion. Assets are stored in Cloudflare R2 and served via presigned URLs.

---

## Monorepo Structure

```
cadence-ai-music/
├── apps/
│   └── web/                    # Next.js app + tRPC API
│       ├── src/pages/          # Route pages
│       ├── src/components/     # React components
│       └── src/server/routers/ # tRPC routers
├── packages/
│   └── db/                     # Prisma schema, client, and types
├── services/
│   └── inference/              # Modal.com Python GPU service
├── docs/
│   └── migrations/             # Migration history notes
├── turbo.json                  # Turborepo pipeline
└── .env.example                # Required environment variables
```

Workspaces are managed with Yarn. The `@cadence/db` package is imported by the web app and any other service that needs database access.

---

## Tech Stack

| Layer          | Technology                                              |
| -------------- | ------------------------------------------------------- |
| Frontend       | Next.js 13, React 18, TypeScript                        |
| API            | tRPC v10 (type-safe, no REST boilerplate)               |
| Database       | PostgreSQL via Supabase, Prisma ORM                     |
| Caching        | Redis (ioredis) — credit balance mirror + rate limiting |
| Auth           | NextAuth.js v4 — Google OAuth + email magic links       |
| Billing        | Stripe (primary), Paddle (legacy migration path)        |
| Storage        | Cloudflare R2 (S3-compatible), presigned PUT/GET        |
| Analytics      | PostHog — events + A/B feature flags                    |
| Error Tracking | Sentry                                                  |
| Cron Jobs      | Vercel Crons                                            |
| GPU Inference  | Modal.com — A10G serverless, 900s timeout               |
| Build System   | Turborepo                                               |
| Python Runtime | FastAPI + Modal framework                               |

---

## Features & Plans

### Job Types

| Job            | Credits | Description                     |
| -------------- | ------- | ------------------------------- |
| Generate Music | 10      | Text prompt → audio track       |
| Separate Stems | 5       | Upload track → isolated stems   |
| Voice Convert  | 8       | Apply voice conversion to audio |
| Music Video    | 20      | Generate video for a track      |

### Tiers

| Plan   | Price  | Credits/Day | Features                                       |
| ------ | ------ | ----------- | ---------------------------------------------- |
| Free   | $0     | 10          | Watermarked output, public library             |
| Pro    | $12/mo | 100         | Private generations, stems, commercial license |
| Studio | $39/mo | 500         | Music videos, priority GPU queue               |

---

## Getting Started

### Prerequisites

- Node.js 18+, Yarn
- PostgreSQL (or a Supabase project)
- Redis
- Stripe account
- Cloudflare R2 bucket
- Modal.com account (for inference)

### Install

```bash
yarn install
```

### Configure environment

```bash
cp .env.example apps/web/.env.local
# Fill in all required values — see Environment Variables below
```

### Set up the database

```bash
yarn db:generate   # Generate Prisma client
yarn db:migrate    # Run migrations (development)
```

### Start development

```bash
yarn dev           # Starts Next.js dev server on port 3000
```

### Forward Stripe webhooks locally

```bash
yarn stripe:listen
```

---

## Environment Variables

All variables live in `apps/web/.env.local`. Copy from `.env.example` and fill in each section.

### Database

```
DATABASE_URL=       # Pooled connection (PgBouncer) — used by the app
DIRECT_URL=         # Direct connection — used by Prisma migrations
```

### NextAuth

```
NEXTAUTH_URL=       # http://localhost:3000
NEXTAUTH_SECRET=    # openssl rand -base64 32

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

EMAIL_SERVER=       # smtp://user:pass@smtp.resend.com:587
EMAIL_FROM=         # Cadence <login@cadence.dev>
```

### Stripe

```
STRIPE_SECRET_KEY=              # sk_test_...
STRIPE_WEBHOOK_SECRET=          # whsec_...
STRIPE_PRICE_PRO_MONTHLY=       # price_...
STRIPE_PRICE_STUDIO_MONTHLY=    # price_...
```

### Redis

```
REDIS_URL=          # redis://localhost:6379
```

### Cloudflare R2

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=          # cadence-assets
R2_PUBLIC_BASE_URL= # https://cdn.cadence.dev
```

### Analytics

```
NEXT_PUBLIC_POSTHOG_KEY=   # phc_...
NEXT_PUBLIC_POSTHOG_HOST=  # https://us.i.posthog.com
POSTHOG_KEY=               # server-side key
```

### Modal Inference

```
MODAL_INFERENCE_URL=  # https://your-workspace--cadence-inference.modal.run
MODAL_TOKEN=          # Bearer token for auth
```

### Cron

```
CRON_SECRET=          # Shared secret for /api/cron/refill endpoint
```

---

## Database

Schema lives in `packages/db/prisma/schema.prisma`. Key model groups:

- **Auth** — `User`, `Account`, `Session`, `VerificationToken` (NextAuth adapter)
- **Billing** — `Plan`, `Subscription`, `BillingProvider` (STRIPE | PADDLE)
- **Credits** — `CreditBalance` (live balance + daily config), `CreditLedger` (double-entry, idempotent)
- **Assets** — `Asset` (R2 files), `GenerationJob` (job tracking with Modal `call_id`)
- **Webhooks** — `WebhookEvent` (dedup by provider event ID)

### Useful commands

```bash
yarn db:generate    # Regenerate Prisma client after schema changes
yarn db:migrate     # Create + apply new migration (dev)
yarn db:deploy      # Apply pending migrations (production)
```

---

## Billing & Credits

### Credit Ledger

PostgreSQL is the source of truth. Redis mirrors the balance for fast reads (1-hour TTL). Every credit mutation writes a row to `CreditLedger` with an `idempotencyKey`, so webhook retries and duplicate submissions never double-charge or double-grant.

Concurrent consumes use `SELECT ... FOR UPDATE` row-level locking on `CreditBalance` to prevent overshooting the balance.

### Daily Refill

A Vercel cron job runs hourly and refills credits according to each user's plan. Refills are resolved against the user's local timezone (stored as an IANA tz string on the `User` row) so credits top up at midnight wall-clock time, not midnight UTC.

Rollover policy is per-plan:

- `rolloverCap == dailyAllowance` → credits burn down daily, no carryover
- `rolloverCap > dailyAllowance` → unused credits carry over up to the cap

### Billing Providers

The schema supports both Stripe and Paddle simultaneously (`BillingProvider` enum + parallel columns). Migration tooling (`yarn migrate:paddle`) handles per-user cutover without downtime.

```bash
yarn reconcile        # Sync subscription state against Stripe
yarn migrate:paddle   # Migrate Paddle subscribers to Stripe
```

---

## Inference Pipeline

1. **Client** calls `studio.generate()` with a prompt, job kind, and a client-generated idempotency UUID.
2. **Server** atomically dedupes the submission, consumes credits (fails fast with `INSUFFICIENT_CREDITS`), creates a `GenerationJob` row, and POSTs to Modal's `/submit` endpoint. Modal returns a `call_id` immediately (non-blocking).
3. **Client** polls `studio.getJob()` every 2 seconds while status is `QUEUED` or `RUNNING`.
4. **Server** checks Modal's `/status/{call_id}` endpoint on each poll:
   - `succeeded` → record R2 asset key, mark job `SUCCEEDED`
   - `failed` → refund credits, mark job `FAILED`
   - `queued/running` → return current status, client retries
5. **Modal GPU function** runs inference, uploads output directly to R2, and returns `{ key, durationMs, contentType }`.

If Modal submission itself fails, credits are refunded immediately and the job is marked `FAILED` — no dangling charges.

### Deploying the inference service

```bash
cd services/inference
pip install -r requirements.txt
modal secret create cadence-inference MODAL_API_TOKEN=<token>
modal deploy app.py    # Outputs the live URL — set as MODAL_INFERENCE_URL
```

See [services/inference/README.md](services/inference/README.md) for the full API contract.

---

## Deploying to Production

1. **Database** — provision a Supabase project; copy pooled and direct URLs to env vars; run `yarn db:deploy`.
2. **Redis** — provision an Upstash Redis instance; set `REDIS_URL`.
3. **R2** — create a Cloudflare R2 bucket; add CORS policy for presigned uploads; set R2 env vars.
4. **Stripe** — create products and prices matching the three plan tiers; register the webhook endpoint (`/api/webhooks/stripe`) and set the webhook secret.
5. **Modal** — deploy the inference service and set `MODAL_INFERENCE_URL` + `MODAL_TOKEN`.
6. **Vercel** — connect the monorepo; set root directory to `apps/web`; add all env vars; enable Vercel Crons.
7. **Auth** — add the production `NEXTAUTH_URL` to your Google OAuth allowed redirect URIs.
