import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/env";

/**
 * Cloudflare R2 via the S3 SDK. R2's S3 endpoint is region-agnostic ("auto").
 * Clients never talk to R2 directly with our keys — they get short-lived
 * presigned URLs for a single object and verb.
 */
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export function buildAssetKey(opts: {
  userId: string;
  kind: string;
  ext: string;
}): string {
  return `u/${opts.userId}/${opts.kind.toLowerCase()}/${randomUUID()}.${opts.ext}`;
}

/** Presigned PUT so the browser uploads straight to R2 (no bytes through us). */
export async function presignUpload(opts: {
  key: string;
  contentType: string;
  expiresIn?: number;
}): Promise<{ url: string; key: string; bucket: string }> {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: opts.key,
    ContentType: opts.contentType,
  });
  const url = await getSignedUrl(r2, cmd, { expiresIn: opts.expiresIn ?? 900 });
  return { url, key: opts.key, bucket: env.R2_BUCKET };
}

/** Presigned GET for downloads; short TTL since the URL is a bearer credential. */
export async function presignDownload(opts: {
  key: string;
  expiresIn?: number;
  downloadName?: string;
}): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: opts.key,
    ResponseContentDisposition: opts.downloadName
      ? `attachment; filename="${opts.downloadName}"`
      : undefined,
  });
  return getSignedUrl(r2, cmd, { expiresIn: opts.expiresIn ?? 300 });
}

export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}
