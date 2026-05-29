import type { NextApiRequest, NextApiResponse } from "next";
import type Stripe from "stripe";
import { prisma, Prisma, BillingProvider } from "@cadence/db";
import { stripe } from "@/server/billing/stripe";
import { handleStripeEvent } from "@/server/billing/webhookHandlers";
import { env } from "@/env";
import { captureException } from "@/lib/sentry";

// Stripe signature verification needs the raw, unparsed body.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Atomically decide whether to process this event.
 *  - first delivery       -> create row (processing), return "process"
 *  - already processed     -> return "skip" (ack, no work)
 *  - currently processing  -> return "skip" (concurrent delivery; avoid dup work)
 *  - previously failed      -> flip failed->processing atomically, return "process"
 *
 * The WebhookEvent primary key (= Stripe event id) is the dedupe key, so this
 * is correct even if Stripe delivers the same event twice concurrently.
 */
async function claimEvent(event: Stripe.Event): Promise<"process" | "skip"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        id: event.id,
        provider: BillingProvider.STRIPE,
        type: event.type,
        status: "processing",
        attempts: 1,
      },
    });
    return "process";
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Row exists. Re-claim only if it had previously failed.
    const reclaimed = await prisma.webhookEvent.updateMany({
      where: { id: event.id, status: "failed" },
      data: { status: "processing", attempts: { increment: 1 } },
    });
    return reclaimed.count === 1 ? "process" : "skip";
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event: Stripe.Event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      raw,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    // Bad signature => never retry-able; 400 so Stripe stops.
    captureException(err, { scope: "stripe-webhook-verify" });
    return res.status(400).send("Signature verification failed");
  }

  let decision: "process" | "skip";
  try {
    decision = await claimEvent(event);
  } catch (err) {
    captureException(err, { scope: "stripe-webhook-claim", eventId: event.id });
    return res.status(500).send("claim failed"); // Stripe retries
  }

  if (decision === "skip") {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    await handleStripeEvent(event);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "processed", processedAt: new Date() },
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    captureException(err, {
      scope: "stripe-webhook-handle",
      eventId: event.id,
      type: event.type,
    });
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    // 500 => Stripe retries; claimEvent will re-claim the failed row next time.
    return res.status(500).send("handler error");
  }
}
