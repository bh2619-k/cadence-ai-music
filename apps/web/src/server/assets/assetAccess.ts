import { prisma, AssetStatus } from "@cadence/db";
import { captureMessage } from "@/lib/sentry";

/**
 * Lock a user's premium asset downloads on refund/chargeback. We intentionally
 * do NOT delete the objects — we flip `accessRevokedAt`/`status` so the
 * download path (assets.getDownloadUrl) refuses to mint a presigned URL. If the
 * dispute is resolved we can restore access without having lost data.
 */
export async function revokeAllPremiumAccess(
  userId: string,
  reason: string,
): Promise<number> {
  const { count } = await prisma.asset.updateMany({
    where: { userId, accessRevokedAt: null, status: AssetStatus.READY },
    data: { accessRevokedAt: new Date(), status: AssetStatus.REVOKED },
  });
  captureMessage("Revoked premium asset access", { userId, reason, count });
  return count;
}

export async function restorePremiumAccess(userId: string): Promise<number> {
  const { count } = await prisma.asset.updateMany({
    where: { userId, status: AssetStatus.REVOKED },
    data: { accessRevokedAt: null, status: AssetStatus.READY },
  });
  return count;
}
