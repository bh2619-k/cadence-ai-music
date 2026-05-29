import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AssetKind, AssetStatus } from "@cadence/db";
import {
  createTRPCRouter,
  protectedProcedure,
  rateLimited,
} from "@/server/trpc";
import {
  buildAssetKey,
  presignUpload,
  presignDownload,
} from "@/server/storage/r2";

const extByContentType: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
};

export const assetsRouter = createTRPCRouter({
  // Presigned PUT. Rate-limited so a client can't mint unlimited upload URLs.
  createUploadUrl: protectedProcedure
    .use(rateLimited({ limit: 30, windowSec: 60 }))
    .input(
      z.object({
        contentType: z.string(),
        kind: z.nativeEnum(AssetKind).default(AssetKind.UPLOAD),
        sizeBytes: z.number().int().positive().max(200 * 1024 * 1024).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ext = extByContentType[input.contentType] ?? "bin";
      const key = buildAssetKey({
        userId: ctx.session.user.id,
        kind: input.kind,
        ext,
      });
      const asset = await ctx.prisma.asset.create({
        data: {
          userId: ctx.session.user.id,
          kind: input.kind,
          bucket: "", // filled by presignUpload below
          key,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          status: AssetStatus.PENDING,
        },
      });
      const { url, bucket } = await presignUpload({
        key,
        contentType: input.contentType,
      });
      await ctx.prisma.asset.update({
        where: { id: asset.id },
        data: { bucket },
      });
      return { assetId: asset.id, uploadUrl: url, key };
    }),

  finalizeUpload: protectedProcedure
    .input(
      z.object({
        assetId: z.string(),
        durationMs: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const asset = await ctx.prisma.asset.findUnique({
        where: { id: input.assetId },
      });
      if (!asset || asset.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return ctx.prisma.asset.update({
        where: { id: asset.id },
        data: { status: AssetStatus.READY, durationMs: input.durationMs },
      });
    }),

  getDownloadUrl: protectedProcedure
    .input(z.object({ assetId: z.string() }))
    .query(async ({ ctx, input }) => {
      const asset = await ctx.prisma.asset.findUnique({
        where: { id: input.assetId },
      });
      if (!asset || asset.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      // Access revoked (e.g. refund/chargeback) — refuse to mint a URL even
      // though the object still exists in R2.
      if (asset.accessRevokedAt || asset.status === AssetStatus.REVOKED) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access to this asset has been revoked",
        });
      }
      const url = await presignDownload({ key: asset.key, expiresIn: 300 });
      return { url, expiresInSec: 300 };
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.asset.findMany({
        where: {
          userId: ctx.session.user.id,
          status: { not: AssetStatus.DELETED },
        },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
      });
    }),
});
