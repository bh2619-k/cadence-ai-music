import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  JobKind,
  JobStatus,
  AssetKind,
  AssetStatus,
  AssetVisibility,
  LedgerReason,
  Prisma,
} from "@cadence/db";
import {
  createTRPCRouter,
  protectedProcedure,
  rateLimited,
} from "@/server/trpc";
import { consumeCredits, grantCredits } from "@/server/credits/creditService";
import {
  submitInference,
  getInferenceStatus,
  type ModalJobKind,
} from "@/server/inference/modalClient";
import { env } from "@/env";

const CREDIT_COST: Record<JobKind, number> = {
  GENERATE_MUSIC: 10,
  SEPARATE_STEMS: 5,
  VOICE_CONVERT: 8,
  MUSIC_VIDEO: 20,
};

const MODAL_KIND: Record<JobKind, ModalJobKind> = {
  GENERATE_MUSIC: "generate_music",
  SEPARATE_STEMS: "separate_stems",
  VOICE_CONVERT: "voice_convert",
  MUSIC_VIDEO: "music_video",
};

const OUTPUT_KIND: Record<JobKind, AssetKind> = {
  GENERATE_MUSIC: AssetKind.TRACK,
  SEPARATE_STEMS: AssetKind.STEM,
  VOICE_CONVERT: AssetKind.TRACK,
  MUSIC_VIDEO: AssetKind.VIDEO,
};

export const studioRouter = createTRPCRouter({
  /**
   * Enqueue an inference job. The flow is deliberately credit-safe and
   * idempotent end to end:
   *   1. dedupe by idempotencyToken (client-generated) — a retried submit
   *      returns the same job and never charges twice;
   *   2. consume credits atomically (keyed on the same token);
   *   3. create the job row (unique key guards a racing double-submit);
   *   4. submit to Modal — and if that fails, refund the credits and fail the
   *      job rather than leaving the user debited for nothing.
   */
  generate: protectedProcedure
    .use(rateLimited({ limit: 20, windowSec: 60 }))
    .input(
      z.object({
        kind: z.nativeEnum(JobKind),
        params: z.record(z.any()).default({}),
        idempotencyToken: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const jobKey = `${userId}:${input.idempotencyToken}`;
      const cost = CREDIT_COST[input.kind];

      const existing = await ctx.prisma.generationJob.findUnique({
        where: { idempotencyKey: jobKey },
      });
      if (existing) {
        // QUEUED/RUNNING/SUCCEEDED: the original submit is the canonical answer.
        // FAILED/CANCELED: the consume on this key was already refunded, so we
        // can't re-spend under the same idempotency key — force the client to
        // mint a fresh token and resubmit.
        if (
          existing.status === JobStatus.FAILED ||
          existing.status === JobStatus.CANCELED
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "JOB_RETRY_REQUIRED",
          });
        }
        return existing;
      }

      const consumed = await consumeCredits({
        userId,
        amount: cost,
        idempotencyKey: `consume:${jobKey}`,
        metadata: { kind: input.kind },
      });
      if (!consumed.ok) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "INSUFFICIENT_CREDITS",
        });
      }

      let job;
      try {
        job = await ctx.prisma.generationJob.create({
          data: {
            userId,
            kind: input.kind,
            status: JobStatus.QUEUED,
            creditsCost: cost,
            idempotencyKey: jobKey,
            params: input.params as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        // P2002: lost the create race; the consume above was idempotent on the
        // same key, so no double charge. Return the winning row.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          const winner = await ctx.prisma.generationJob.findUnique({
            where: { idempotencyKey: jobKey },
          });
          if (winner) return winner;
        }
        // Any other failure (DB connection drop, FK violation, ...): the user
        // was already debited above and there's no job row to attach a refund
        // to later, so compensate now keyed on the same token.
        await grantCredits({
          userId,
          amount: cost,
          reason: LedgerReason.REFUND_REVERSAL,
          idempotencyKey: `refund:${jobKey}`,
          metadata: { reason: "job_create_failed" },
        });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }

      try {
        const { callId } = await submitInference({
          kind: MODAL_KIND[input.kind],
          params: input.params,
          idempotencyKey: jobKey,
        });
        return ctx.prisma.generationJob.update({
          where: { id: job.id },
          data: { status: JobStatus.RUNNING, modalCallId: callId },
        });
      } catch {
        await grantCredits({
          userId,
          amount: cost,
          reason: LedgerReason.REFUND_REVERSAL,
          idempotencyKey: `refund:${jobKey}`,
          metadata: { reason: "modal_submit_failed" },
        });
        await ctx.prisma.generationJob.update({
          where: { id: job.id },
          data: { status: JobStatus.FAILED, error: "inference submit failed" },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Inference backend unavailable; your credits were refunded.",
        });
      }
    }),

  /**
   * Poll a job. Lazily reconciles RUNNING jobs against Modal: on success it
   * records the output asset and flips to SUCCEEDED; on failure it refunds and
   * flips to FAILED. (In prod a Modal completion webhook drives this too; the
   * lazy poll is the read-path safety net.)
   */
  getJob: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ ctx, input }) => {
      const job = await ctx.prisma.generationJob.findUnique({
        where: { id: input.jobId },
        include: { outputAsset: true },
      });
      if (!job || job.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (job.status !== JobStatus.RUNNING || !job.modalCallId) return job;

      try {
        const status = await getInferenceStatus(job.modalCallId);

        if (status.status === "succeeded" && status.output) {
          try {
            return await ctx.prisma.$transaction(async (tx) => {
              const asset = await tx.asset.create({
                data: {
                  userId: job.userId,
                  kind: OUTPUT_KIND[job.kind],
                  bucket: env.R2_BUCKET,
                  key: status.output!.key,
                  contentType: status.output!.contentType,
                  durationMs: status.output!.durationMs,
                  visibility: AssetVisibility.PRIVATE,
                  status: AssetStatus.READY,
                },
              });
              return tx.generationJob.update({
                where: { id: job.id },
                data: { status: JobStatus.SUCCEEDED, outputAssetId: asset.id },
                include: { outputAsset: true },
              });
            });
          } catch (err) {
            // Two concurrent polls can both reach this branch before either
            // writes. The loser gets a P2002 on Asset.key; re-read the job so
            // the client sees the winning SUCCEEDED row instead of a 500.
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            ) {
              return ctx.prisma.generationJob.findUniqueOrThrow({
                where: { id: job.id },
                include: { outputAsset: true },
              });
            }
            throw err;
          }
        }

        if (status.status === "failed") {
          await grantCredits({
            userId: job.userId,
            amount: job.creditsCost,
            reason: LedgerReason.REFUND_REVERSAL,
            idempotencyKey: `refund:${job.idempotencyKey}`,
            metadata: { reason: "modal_failed" },
          });
          return ctx.prisma.generationJob.update({
            where: { id: job.id },
            data: {
              status: JobStatus.FAILED,
              error: status.error ?? "inference failed",
            },
            include: { outputAsset: true },
          });
        }
      } catch {
        // Transient poll failure — leave the job RUNNING; the client polls again.
      }

      return job;
    }),

  listJobs: protectedProcedure
    .input(
      z.object({ limit: z.number().min(1).max(50).default(20) }).optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.generationJob.findMany({
        where: { userId: ctx.session.user.id },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 20,
        include: { outputAsset: true },
      });
    }),
});
