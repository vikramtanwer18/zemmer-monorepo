import { randomUUID } from "node:crypto";
import { inOrder, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  roleLabel,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import {
  normalizePhone,
  noScanner,
  type FileScanner,
} from "../members/service";
import { minorToMajorString, parseMajorToMinor } from "../money";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import type { UploadStorage } from "../tenancy/settings";
import { fromDbDate, isLocalDate, toDbDate } from "../time/dates";
import { parseInput } from "../validation";

/** The staff member (membership + roles) the context may see, or NOT_FOUND / FORBIDDEN. */
export async function loadStaffMember(
  tx: TenantTransaction,
  ctx: AuthContext,
  userId: string,
  key: "staff.view" | "staff.manage",
) {
  const membership = await tx.tenantMembership.findFirst({
    where: { userId },
    include: {
      roles: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!membership) throw new AppError("NOT_FOUND", "Staff member not found.");
  const allowed = allowedBranchIds(ctx, key);
  const visible =
    allowed === "ALL" ||
    membership.roles.some(
      (r) => r.branchId === null || allowed.includes(r.branchId),
    );
  if (!visible || !hasPermission(ctx, key))
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to do that for this staff member.",
    );
  return membership;
}

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable().optional(),
  );

const profileSchema = z.object({
  phone: optionalText(30),
  jobTitle: optionalText(80),
  employmentType: z.preprocess(
    (v) => (v === "" ? null : v),
    z.enum(["FULL_TIME", "PART_TIME", "CONTRACT"]).nullable().optional(),
  ),
  startDate: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().refine(isLocalDate, "Pick a valid date.").nullable().optional(),
  ),
  emergencyName: optionalText(80),
  emergencyPhone: optionalText(30),
  // Pay details: only accepted with staff.compensation.view.
  payBasis: z.preprocess(
    (v) => (v === "" ? null : v),
    z.enum(["MONTHLY", "HOURLY", "PER_SESSION"]).nullable().optional(),
  ),
  payRate: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().trim().max(20).nullable().optional(),
  ),
  payNotes: optionalText(500),
});

const PAY_FIELDS = ["payBasis", "payRate", "payNotes"] as const;

export async function getStaffProfile(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
) {
  await guard(deps, ctx, { permission: "staff.view" });
  const canPay = hasPermission(ctx, "staff.compensation.view");
  return inTenant(deps, ctx, async (tx) => {
    const membership = await loadStaffMember(tx, ctx, userId, "staff.view");
    const [profile, trainer, branches] = await inOrder([
      tx.staffProfile.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
      }),
      tx.trainerProfile.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        include: {
          certifications: { orderBy: { createdAt: "desc" } },
          _count: { select: { clients: { where: { endedAt: null } } } },
        },
      }),
      tx.branch.findMany({ select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    return {
      userId,
      name: membership.user.name,
      email: membership.user.email,
      status: membership.status,
      joinedAt: membership.createdAt,
      roles: membership.roles.map((r) => ({
        roleKey: r.roleKey,
        label: roleLabel(r.roleKey),
        branch: r.branchId
          ? (branchName.get(r.branchId) ?? "?")
          : "All branches",
      })),
      profile: profile
        ? {
            phone: profile.phone,
            jobTitle: profile.jobTitle,
            employmentType: profile.employmentType,
            startDate: profile.startDate ? fromDbDate(profile.startDate) : null,
            emergencyName: profile.emergencyName,
            emergencyPhone: profile.emergencyPhone,
          }
        : null,
      // Never sent to a viewer without staff.compensation.view.
      pay:
        canPay && profile
          ? {
              payBasis: profile.payBasis,
              payRate:
                profile.payRateMinor === null
                  ? null
                  : minorToMajorString(Number(profile.payRateMinor)),
              payNotes: profile.payNotes,
            }
          : null,
      canSeePay: canPay,
      trainer: trainer
        ? {
            id: trainer.id,
            displayName: trainer.displayName,
            specialties: trainer.specialties,
            bio: trainer.bio,
            visibleToMembers: trainer.visibleToMembers,
            status: trainer.status,
            activeClients: trainer._count.clients,
            certifications: trainer.certifications.map((c) => ({
              id: c.id,
              title: c.title,
              issuer: c.issuer,
              issuedOn: c.issuedOn ? fromDbDate(c.issuedOn) : null,
              expiresOn: c.expiresOn ? fromDbDate(c.expiresOn) : null,
              hasFile: c.fileId !== null,
            })),
          }
        : null,
      canManage: hasPermission(ctx, "staff.manage"),
    };
  });
}

/** Staff details; pay fields need staff.compensation.view and are audited without the values. */
export async function updateStaffProfile(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  const input = parseInput(profileSchema, raw);
  const canPay = hasPermission(ctx, "staff.compensation.view");
  const sentPay = PAY_FIELDS.some((k) => input[k] !== undefined);
  if (sentPay && !canPay)
    throw new AppError("FORBIDDEN", "You can't change pay details.");
  let phone: string | null | undefined = input.phone;
  if (phone) {
    phone = normalizePhone(phone);
    if (!phone)
      throw new AppError("VALIDATION_FAILED", "Enter a valid phone number.", {
        fields: { phone: ["Enter a valid phone number."] },
      });
  }
  let payRateMinor: bigint | null | undefined;
  if (input.payRate !== undefined) {
    if (input.payRate === null) payRateMinor = null;
    else {
      const minor = parseMajorToMinor(input.payRate);
      if (minor === null || minor < 0)
        throw new AppError("VALIDATION_FAILED", "Enter an amount.", {
          fields: { payRate: ["Enter an amount, e.g. 25000."] },
        });
      payRateMinor = BigInt(minor);
    }
  }
  return inTenant(deps, ctx, async (tx) => {
    await loadStaffMember(tx, ctx, userId, "staff.manage");
    const data = {
      ...(phone !== undefined ? { phone } : {}),
      ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
      ...(input.employmentType !== undefined
        ? { employmentType: input.employmentType }
        : {}),
      ...(input.startDate !== undefined
        ? { startDate: input.startDate ? toDbDate(input.startDate) : null }
        : {}),
      ...(input.emergencyName !== undefined
        ? { emergencyName: input.emergencyName }
        : {}),
      ...(input.emergencyPhone !== undefined
        ? { emergencyPhone: input.emergencyPhone }
        : {}),
      ...(canPay && input.payBasis !== undefined
        ? { payBasis: input.payBasis }
        : {}),
      ...(canPay && payRateMinor !== undefined ? { payRateMinor } : {}),
      ...(canPay && input.payNotes !== undefined
        ? { payNotes: input.payNotes }
        : {}),
    };
    const profile = await tx.staffProfile.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
      create: { tenantId: ctx.tenantId, userId, ...data },
      update: data,
    });
    await recordAudit(tx, ctx, {
      action: "staff.profile_updated",
      entityType: "StaffProfile",
      entityId: profile.id,
      after: {
        ...Object.fromEntries(
          Object.entries(data).filter(
            ([k]) => !["payBasis", "payRateMinor", "payNotes"].includes(k),
          ),
        ),
        ...(sentPay ? { payDetails: "changed" } : {}),
      },
    });
    return profile;
  });
}

// --- trainer profiles -----------------------------------------------------------------------

const trainerSchema = z.object({
  displayName: z.string().trim().min(2, "Enter the name members see.").max(80),
  specialties: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(z.string().max(40)).max(20).default([]),
  ),
  bio: optionalText(2000),
  visibleToMembers: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
  active: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === undefined || v === true || v === "on"),
});

/** Makes a staff member bookable as a trainer (or updates their trainer profile). */
export async function upsertTrainerProfile(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  const input = parseInput(trainerSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const membership = await loadStaffMember(tx, ctx, userId, "staff.manage");
    if (membership.status !== "ACTIVE")
      throw new AppError("CONFLICT", "This staff member is deactivated.");
    const data = {
      displayName: input.displayName,
      specialties: input.specialties,
      bio: input.bio ?? null,
      visibleToMembers: input.visibleToMembers,
      status: input.active ? ("ACTIVE" as const) : ("ARCHIVED" as const),
    };
    const trainer = await tx.trainerProfile.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
      create: { tenantId: ctx.tenantId, userId, ...data },
      update: data,
    });
    await recordAudit(tx, ctx, {
      action: "trainer.profile_saved",
      entityType: "TrainerProfile",
      entityId: trainer.id,
      after: data,
    });
    return trainer;
  });
}

/** Active trainers (for class and PT pickers). */
export async function listTrainers(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { includeInactive?: boolean } = {},
) {
  await guard(deps, ctx, { permission: "classes.view" });
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.trainerProfile.findMany({
      where: options.includeInactive ? {} : { status: "ACTIVE" },
      orderBy: { displayName: "asc" },
      include: {
        _count: { select: { clients: { where: { endedAt: null } } } },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      userId: t.userId,
      displayName: t.displayName,
      specialties: t.specialties,
      status: t.status,
      activeClients: t._count.clients,
    }));
  });
}

/** The caller's own trainer profile, if any. */
export async function myTrainerProfile(deps: CoreDeps, ctx: AuthContext) {
  return inTenant(deps, ctx, (tx) =>
    tx.trainerProfile.findUnique({
      where: {
        tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId },
      },
    }),
  );
}

// --- certifications -------------------------------------------------------------------------

export const CERTIFICATE_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export const CERTIFICATE_MAX_BYTES = 5 * 1024 * 1024;

const certRequestSchema = z.object({
  contentType: z.enum(
    Object.keys(CERTIFICATE_TYPES) as [keyof typeof CERTIFICATE_TYPES],
  ),
  size: z
    .number()
    .int()
    .positive()
    .max(CERTIFICATE_MAX_BYTES, "Files must be 5 MB or smaller."),
});

async function loadTrainer(
  tx: TenantTransaction,
  ctx: AuthContext,
  trainerId: string,
) {
  const trainer = await tx.trainerProfile.findUnique({
    where: { id: trainerId },
  });
  if (!trainer) throw new AppError("NOT_FOUND", "Trainer not found.");
  await loadStaffMember(tx, ctx, trainer.userId, "staff.manage");
  return trainer;
}

export async function createCertificateUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  trainerId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  const input = parseInput(certRequestSchema, raw);
  await inTenant(deps, ctx, (tx) => loadTrainer(tx, ctx, trainerId));
  const key = `tenants/${ctx.tenantId}/trainers/${trainerId}/${randomUUID()}.${CERTIFICATE_TYPES[input.contentType]}`;
  const upload = await storage.createUpload({
    key,
    contentType: input.contentType,
    maxBytes: CERTIFICATE_MAX_BYTES,
  });
  return { key, ...upload };
}

const certificationSchema = z.object({
  title: z.string().trim().min(2, "Name the certification.").max(120),
  issuer: optionalText(120),
  issuedOn: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().refine(isLocalDate, "Pick a valid date.").nullable().optional(),
  ),
  expiresOn: z.preprocess(
    (v) => (v === "" ? null : v),
    z.string().refine(isLocalDate, "Pick a valid date.").nullable().optional(),
  ),
  key: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().max(300).optional(),
  ),
  filename: z.string().trim().max(120).optional(),
});

/** Adds a certification, optionally with an uploaded file (same checks as member documents). */
export async function addCertification(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  trainerId: string,
  raw: unknown,
  scan: FileScanner = noScanner,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  const input = parseInput(certificationSchema, raw);
  let file: { key: string; size: number; contentType: string } | null = null;
  if (input.key) {
    const pattern = new RegExp(
      `^tenants/${ctx.tenantId}/trainers/${trainerId}/[0-9a-f-]{36}\\.(pdf|jpg|png|webp)$`,
    );
    if (!pattern.test(input.key))
      throw new AppError(
        "FORBIDDEN",
        "That upload doesn't belong to this trainer.",
      );
    const head = await storage.head(input.key);
    if (!head)
      throw new AppError(
        "NOT_FOUND",
        "The upload did not arrive. Please try again.",
      );
    if (
      head.size > CERTIFICATE_MAX_BYTES ||
      !head.contentType ||
      !(head.contentType in CERTIFICATE_TYPES)
    )
      throw new AppError(
        "VALIDATION_FAILED",
        "Files must be PDF, JPEG, PNG or WebP and at most 5 MB.",
      );
    file = { key: input.key, size: head.size, contentType: head.contentType };
  }
  const scanStatus = file ? await scan(file.key) : null;
  return inTenant(deps, ctx, async (tx) => {
    const trainer = await loadTrainer(tx, ctx, trainerId);
    const record = file
      ? await tx.fileRecord.create({
          data: {
            tenantId: ctx.tenantId,
            key: file.key,
            filename: input.filename || "certificate",
            contentType: file.contentType,
            size: file.size,
            purpose: "CERTIFICATE",
            scanStatus: scanStatus!,
            uploadedByUserId: ctx.userId,
          },
        })
      : null;
    const cert = await tx.trainerCertification.create({
      data: {
        tenantId: ctx.tenantId,
        trainerId: trainer.id,
        title: input.title,
        issuer: input.issuer ?? null,
        issuedOn: input.issuedOn ? toDbDate(input.issuedOn) : null,
        expiresOn: input.expiresOn ? toDbDate(input.expiresOn) : null,
        fileId: record?.id ?? null,
      },
    });
    await recordAudit(tx, ctx, {
      action: "trainer.certification_added",
      entityType: "TrainerCertification",
      entityId: cert.id,
      meta: { trainerId: trainer.id, title: input.title, file: !!record },
    });
    return cert;
  });
}

export async function removeCertification(
  deps: CoreDeps,
  ctx: AuthContext,
  certificationId: string,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const cert = await tx.trainerCertification.findUnique({
      where: { id: certificationId },
    });
    if (!cert) throw new AppError("NOT_FOUND", "Certification not found.");
    await loadTrainer(tx, ctx, cert.trainerId);
    await tx.trainerCertification.delete({ where: { id: cert.id } });
    await recordAudit(tx, ctx, {
      action: "trainer.certification_removed",
      entityType: "TrainerCertification",
      entityId: cert.id,
      meta: { title: cert.title },
    });
  });
}

export async function certificateDownloadUrl(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  certificationId: string,
) {
  await guard(deps, ctx, { permission: "staff.view" });
  const cert = await inTenant(deps, ctx, async (tx) => {
    const c = await tx.trainerCertification.findUnique({
      where: { id: certificationId },
      include: { file: true, trainer: true },
    });
    if (!c || !c.file) throw new AppError("NOT_FOUND", "File not found.");
    await loadStaffMember(tx, ctx, c.trainer.userId, "staff.view");
    return c;
  });
  if (cert.file!.scanStatus === "INFECTED")
    throw new AppError("FORBIDDEN", "This file failed the virus scan.");
  return storage.getUrl(cert.file!.key, 60);
}

/** Staff activity log: the audit trail filtered to one actor (audit.view). */
export function staffActivityFilters(userId: string, page = 1) {
  return { actorUserId: userId, page, pageSize: 25 };
}

export function requireStaffManage(ctx: AuthContext) {
  requirePermission(ctx, "staff.manage");
}
