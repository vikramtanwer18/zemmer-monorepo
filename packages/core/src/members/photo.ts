import { randomUUID } from "node:crypto";
import { withTenant } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { hasPermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { canViewClient } from "../staff/assignments";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import type { UploadStorage } from "../tenancy/settings";
import { parseInput } from "../validation";
import type { MemberContext } from "./self";
import { loadMember, noScanner, type FileScanner } from "./service";

/**
 * Member photo (M3): shown on the digital card and on the scan result so staff can check the
 * person matches the pass. Images only, small, private bucket, short-lived links.
 */
export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const requestSchema = z.object({
  contentType: z.enum(Object.keys(PHOTO_TYPES) as [keyof typeof PHOTO_TYPES]),
  size: z
    .number()
    .int()
    .positive()
    .max(PHOTO_MAX_BYTES, "Photos must be 2 MB or smaller."),
});

export async function createPhotoUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const input = parseInput(requestSchema, raw);
  await inTenant(deps, ctx, (tx) =>
    loadMember(tx, ctx, memberId, "members.edit"),
  );
  const key = `tenants/${ctx.tenantId}/members/${memberId}/photo-${randomUUID()}.${PHOTO_TYPES[input.contentType]}`;
  const upload = await storage.createUpload({
    key,
    contentType: input.contentType,
    maxBytes: PHOTO_MAX_BYTES,
  });
  return { key, ...upload };
}

const confirmSchema = z.object({ key: z.string().max(300) });

export async function confirmPhotoUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
  scan: FileScanner = noScanner,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const { key } = parseInput(confirmSchema, raw);
  const pattern = new RegExp(
    `^tenants/${ctx.tenantId}/members/${memberId}/photo-[0-9a-f-]{36}\\.(jpg|png|webp)$`,
  );
  if (!pattern.test(key))
    throw new AppError(
      "FORBIDDEN",
      "That upload doesn't belong to this member.",
    );
  const head = await storage.head(key);
  if (!head)
    throw new AppError(
      "NOT_FOUND",
      "The upload did not arrive. Please try again.",
    );
  if (
    head.size > PHOTO_MAX_BYTES ||
    !head.contentType ||
    !(head.contentType in PHOTO_TYPES)
  )
    throw new AppError(
      "VALIDATION_FAILED",
      "Photos must be JPEG, PNG or WebP and at most 2 MB.",
    );
  const scanStatus = await scan(key);
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.edit");
    const file = await tx.fileRecord.create({
      data: {
        tenantId: ctx.tenantId,
        key,
        filename: "photo",
        contentType: head.contentType!,
        size: head.size,
        purpose: "MEMBER_PHOTO",
        scanStatus,
        uploadedByUserId: ctx.userId,
      },
    });
    await tx.memberProfile.update({
      where: { id: member.id },
      data: { photoFileId: file.id },
    });
    await recordAudit(tx, ctx, {
      action: "member.photo_updated",
      entityType: "MemberProfile",
      entityId: member.id,
      branchId: member.homeBranchId,
    });
    return { fileId: file.id };
  });
}

/**
 * A 60-second link to the photo for staff who may see the member (members.view, the scanner
 * at the member's branch, or the assigned trainer). Null when there is no photo.
 */
export async function memberPhotoUrl(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  memberId: string,
): Promise<string | null> {
  await guard(deps, ctx, { permission: "dashboard.view" });
  const file = await inTenant(deps, ctx, async (tx) => {
    const member = await tx.memberProfile.findUnique({
      where: { id: memberId },
      include: { photo: true },
    });
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    const allowed =
      hasPermission(ctx, "attendance.scan") ||
      (await canViewClient(tx, ctx, member.id, member.homeBranchId));
    if (!allowed) throw new AppError("FORBIDDEN", "You can't see this member.");
    return member.photo;
  });
  if (!file || file.scanStatus === "INFECTED") return null;
  return storage.getUrl(file.key, 60);
}

/** The member's own photo (member app card). */
export async function myPhotoUrl(
  deps: CoreDeps,
  storage: UploadStorage,
  mctx: MemberContext,
): Promise<string | null> {
  const file = await withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) =>
      (
        await tx.memberProfile.findUniqueOrThrow({
          where: { id: mctx.memberId },
          include: { photo: true },
        })
      ).photo,
    { userId: mctx.userId },
  );
  if (!file || file.scanStatus === "INFECTED") return null;
  return storage.getUrl(file.key, 300);
}
