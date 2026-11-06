import { randomUUID } from "node:crypto";
import type { Prisma, TenantTransaction } from "@gym/db";
import { inOrder, withTenant } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { bumpUsage, checkQuota } from "../entitlements";
import { AppError } from "../errors";
import { isGstStateCode } from "../gst";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import type { UploadStorage } from "../tenancy/settings";
import { newInvitationToken, INVITATION_TTL_DAYS } from "../tenancy/staff";
import { addDays, isLocalDate, todayIn, toDbDate } from "../time/dates";
import { emailSchema, parseInput } from "../validation";

// --- validation -----------------------------------------------------------------------------

/** India-first E.164: 10-digit mobiles get +91; anything with + is kept if it looks valid. */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, "");
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  if (/^0[6-9]\d{9}$/.test(compact)) return `+91${compact.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(compact)) return `+${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  return null;
}

const phoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const phone = normalizePhone(v);
    if (!phone)
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid mobile number, e.g. 98765 43210.",
      });
    return phone ?? "";
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

export const memberInputSchema = z
  .object({
    firstName: z.string().trim().min(1, "Enter a first name.").max(60),
    lastName: optionalText(60),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    dateOfBirth: z
      .string()
      .optional()
      .refine((v) => !v || isLocalDate(v), "Enter a valid date."),
    gender: z.enum(["FEMALE", "MALE", "OTHER", "UNDISCLOSED"]).optional(),
    addressLine1: optionalText(120),
    city: optionalText(60),
    stateCode: z
      .string()
      .optional()
      .refine((v) => !v || isGstStateCode(v), "Pick a state."),
    postalCode: optionalText(10),
    emergencyName: optionalText(80),
    emergencyPhone: phoneSchema.optional(),
    homeBranchId: z.uuid("Pick a branch."),
    source: z.enum(["STAFF", "WALK_IN", "REFERRAL"]).default("STAFF"),
  })
  .refine((v) => v.email || v.phone, {
    path: ["phone"],
    message: "Add a mobile number or an email.",
  });

const createSchema = memberInputSchema.and(
  z.object({
    marketingEmail: checkbox,
    marketingWhatsapp: checkbox,
    confirmDuplicate: checkbox,
  }),
);

export type MemberInput = z.infer<typeof memberInputSchema>;

// --- helpers -----------------------------------------------------------------------------

export const memberName = (m: { firstName: string; lastName: string | null }) =>
  [m.firstName, m.lastName].filter(Boolean).join(" ");

async function nextMemberCode(
  tx: TenantTransaction,
  tenantId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO app.tenant_counter (tenant_id, key, value) VALUES (${tenantId}::uuid, 'member_code', 1)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = app.tenant_counter.value + 1
    RETURNING value`;
  return `M-${String(rows[0]!.value).padStart(6, "0")}`;
}

function memberBranchFilter(ctx: AuthContext): Prisma.MemberProfileWhereInput {
  const allowed = allowedBranchIds(ctx, "members.view");
  return allowed === "ALL" ? {} : { homeBranchId: { in: allowed } };
}

/** Loads a member the context may act on for `key` (branch-scoped by home branch). */
export async function loadMember(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
  key:
    | "members.view"
    | "members.edit"
    | "members.notes_private"
    | "memberships.sell"
    | "memberships.manage"
    | "billing.view",
) {
  const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  if (!hasPermission(ctx, key, { branchId: member.homeBranchId })) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to do that for this member.",
    );
  }
  return member;
}

async function assertBranchUsable(
  tx: TenantTransaction,
  ctx: AuthContext,
  branchId: string,
) {
  const branch = await tx.branch.findUnique({ where: { id: branchId } });
  if (!branch || branch.status !== "ACTIVE") {
    throw new AppError("VALIDATION_FAILED", "Pick an active branch.", {
      fields: { homeBranchId: ["Pick an active branch."] },
    });
  }
  requirePermission(ctx, "members.create", { branchId });
}

export type DuplicateCandidate = {
  id: string;
  name: string;
  memberCode: string;
  phone: string | null;
  email: string | null;
};

export async function findDuplicates(
  tx: TenantTransaction,
  input: { email?: string | null; phone?: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const or: Prisma.MemberProfileWhereInput[] = [];
  if (input.phone) or.push({ phone: input.phone });
  if (input.email) or.push({ email: input.email });
  if (or.length === 0) return [];
  const rows = await tx.memberProfile.findMany({
    where: {
      OR: or,
      status: { not: "ARCHIVED" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    take: 5,
  });
  return rows.map((r) => ({
    id: r.id,
    name: memberName(r),
    memberCode: r.memberCode,
    phone: r.phone,
    email: r.email,
  }));
}

const CONSENT_TEXT = {
  SERVICE: "Service messages about my membership, payments and visits.",
  MARKETING: "Offers, events and news from the gym.",
};

async function recordConsentsAtOnboarding(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  capturedByUserId: string | null,
  method: "STAFF_FORM" | "SIGNUP" | "IMPORT",
  marketing: { email: boolean; whatsapp: boolean },
) {
  const rows: Prisma.ContactConsentCreateManyInput[] = [];
  // Service messages: default yes (needed to run the membership).
  for (const channel of ["EMAIL", "WHATSAPP"] as const) {
    rows.push({
      tenantId,
      memberId,
      channel,
      purpose: "SERVICE",
      status: "GRANTED",
      method,
      capturedByUserId,
      evidence: CONSENT_TEXT.SERVICE,
    });
  }
  // Marketing: explicit opt-in only; no row means no consent.
  if (marketing.email) {
    rows.push({
      tenantId,
      memberId,
      channel: "EMAIL",
      purpose: "MARKETING",
      status: "GRANTED",
      method,
      capturedByUserId,
      evidence: CONSENT_TEXT.MARKETING,
    });
  }
  if (marketing.whatsapp) {
    rows.push({
      tenantId,
      memberId,
      channel: "WHATSAPP",
      purpose: "MARKETING",
      status: "GRANTED",
      method,
      capturedByUserId,
      evidence: CONSENT_TEXT.MARKETING,
    });
  }
  await tx.contactConsent.createMany({ data: rows });
}

// --- create / update ------------------------------------------------------------------------

export async function createMemberTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  ent: Awaited<ReturnType<typeof guard>>,
  raw: unknown,
  method: "STAFF_FORM" | "IMPORT" = "STAFF_FORM",
) {
  const input = parseInput(createSchema, raw);
  await assertBranchUsable(tx, ctx, input.homeBranchId);
  if (!input.confirmDuplicate) {
    const duplicates = await findDuplicates(tx, input);
    if (duplicates.length > 0) {
      throw new AppError(
        "CONFLICT",
        "A member with this mobile number or email already exists.",
        {
          details: { duplicates },
          fields: {
            phone: [
              "Possible duplicate. Check the existing member, or tick 'Create anyway'.",
            ],
          },
        },
      );
    }
  }
  await checkQuota(tx, ent, ctx.tenantId, "members.max", 1);
  const member = await tx.memberProfile.create({
    data: {
      tenantId: ctx.tenantId,
      homeBranchId: input.homeBranchId,
      memberCode: await nextMemberCode(tx, ctx.tenantId),
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ?? null,
      phone: input.phone || null,
      dateOfBirth: input.dateOfBirth ? toDbDate(input.dateOfBirth) : null,
      gender: input.gender ?? null,
      addressLine1: input.addressLine1,
      city: input.city,
      stateCode: input.stateCode || null,
      postalCode: input.postalCode,
      emergencyName: input.emergencyName,
      emergencyPhone: input.emergencyPhone || null,
      source: method === "IMPORT" ? "IMPORT" : input.source,
    },
  });
  await bumpUsage(tx, ctx.tenantId, "members.max", 1);
  await recordConsentsAtOnboarding(
    tx,
    ctx.tenantId,
    member.id,
    ctx.userId,
    method,
    {
      email: input.marketingEmail,
      whatsapp: input.marketingWhatsapp,
    },
  );
  await recordAudit(tx, ctx, {
    action: "member.created",
    entityType: "MemberProfile",
    entityId: member.id,
    branchId: member.homeBranchId,
    after: {
      memberCode: member.memberCode,
      name: memberName(member),
      source: member.source,
    },
  });
  return member;
}

export async function createMember(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const ent = await guard(deps, ctx, {
    permission: "members.create",
    write: true,
  });
  return inTenant(deps, ctx, (tx) => createMemberTx(tx, ctx, ent, raw));
}

export async function updateMember(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const input = parseInput(memberInputSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const before = await loadMember(tx, ctx, memberId, "members.edit");
    if (input.homeBranchId !== before.homeBranchId) {
      requirePermission(ctx, "members.edit", { branchId: input.homeBranchId });
    }
    const after = await tx.memberProfile.update({
      where: { id: memberId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone || null,
        dateOfBirth: input.dateOfBirth ? toDbDate(input.dateOfBirth) : null,
        gender: input.gender ?? null,
        addressLine1: input.addressLine1,
        city: input.city,
        stateCode: input.stateCode || null,
        postalCode: input.postalCode,
        emergencyName: input.emergencyName,
        emergencyPhone: input.emergencyPhone || null,
        homeBranchId: input.homeBranchId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "member.updated",
      entityType: "MemberProfile",
      entityId: memberId,
      branchId: after.homeBranchId,
      before: {
        email: before.email,
        phone: before.phone,
        homeBranchId: before.homeBranchId,
      },
      after: {
        email: after.email,
        phone: after.phone,
        homeBranchId: after.homeBranchId,
      },
    });
    return after;
  });
}

// --- reads -----------------------------------------------------------------------------------

export const listMembersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z
    .enum(["ACTIVE", "PENDING_APPROVAL", "ARCHIVED", "all"])
    .default("ACTIVE"),
  branchId: z.uuid().optional(),
  planCode: z.string().max(40).optional(),
  membership: z
    .enum(["active", "paused", "pending", "expired", "none"])
    .optional(),
  expiringDays: z.coerce.number().int().min(1).max(365).optional(),
  hasDues: z.union([z.literal("1"), z.literal("true")]).optional(),
  joinedFrom: z.string().optional(),
  joinedTo: z.string().optional(),
  sort: z.enum(["name", "joinedAt", "memberCode"]).default("joinedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

export type ListMembersInput = z.infer<typeof listMembersSchema>;

export async function listMembers(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  requirePermission(ctx, "members.view");
  const input = parseInput(listMembersSchema, raw);
  const today = todayIn(ctx.timezone, nowOf(deps));
  const and: Prisma.MemberProfileWhereInput[] = [memberBranchFilter(ctx)];
  if (input.status !== "all") and.push({ status: input.status });
  if (input.branchId) and.push({ homeBranchId: input.branchId });
  if (input.q) {
    const q = input.q;
    const phone = normalizePhone(q);
    and.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { memberCode: { contains: q.toUpperCase() } },
        { email: { contains: q.toLowerCase() } },
        { phone: { contains: phone ?? q.replace(/\s/g, "") } },
      ],
    });
  }
  if (input.planCode)
    and.push({
      memberships: {
        some: {
          plan: { code: input.planCode },
          status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
        },
      },
    });
  const current = {
    startDate: { lte: toDbDate(today) },
    endDate: { gte: toDbDate(today) },
  };
  if (input.membership === "active")
    and.push({ memberships: { some: { status: "ACTIVE", ...current } } });
  if (input.membership === "paused")
    and.push({ memberships: { some: { status: "PAUSED" } } });
  if (input.membership === "pending")
    and.push({ memberships: { some: { status: "PENDING_PAYMENT" } } });
  if (input.membership === "expired") {
    and.push(
      { memberships: { some: { status: "EXPIRED" } } },
      {
        memberships: {
          none: { status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] } },
        },
      },
    );
  }
  if (input.membership === "none") and.push({ memberships: { none: {} } });
  if (input.expiringDays) {
    // KPI "Expiring memberships": ACTIVE, ending in [today, today+N), no renewal already bought.
    and.push({
      memberships: {
        some: {
          status: "ACTIVE",
          endDate: {
            gte: toDbDate(today),
            lt: toDbDate(addDays(today, input.expiringDays)),
          },
        },
      },
    });
    and.push({
      memberships: {
        none: {
          status: { in: ["ACTIVE", "PENDING_PAYMENT"] },
          startDate: { gt: toDbDate(today) },
        },
      },
    });
  }
  if (input.hasDues)
    and.push({
      invoices: { some: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } } },
    });
  if (input.joinedFrom || input.joinedTo) {
    and.push({
      joinedAt: {
        ...(input.joinedFrom ? { gte: new Date(input.joinedFrom) } : {}),
        ...(input.joinedTo ? { lt: new Date(input.joinedTo) } : {}),
      },
    });
  }
  const where: Prisma.MemberProfileWhereInput = { AND: and };
  const orderBy: Prisma.MemberProfileOrderByWithRelationInput[] =
    input.sort === "name"
      ? [{ firstName: input.dir }, { lastName: input.dir }]
      : [{ [input.sort]: input.dir }];

  return inTenant(deps, ctx, async (tx) => {
    const [rows, total] = await inOrder([
      tx.memberProfile.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        include: {
          homeBranch: { select: { name: true, code: true } },
          memberships: {
            where: {
              status: {
                in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT", "EXPIRED"],
              },
            },
            orderBy: { endDate: "desc" },
            take: 1,
            include: { plan: { select: { name: true } } },
          },
        },
      }),
      tx.memberProfile.count({ where }),
    ]);
    return {
      rows,
      total,
      page: input.page,
      pageSize: input.pageSize,
      filters: input,
    };
  });
}

export async function getMemberProfile(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.view");
    const seePrivate = hasPermission(ctx, "members.notes_private", {
      branchId: member.homeBranchId,
    });
    const [branch, memberships, notes, documents, consents] = await inOrder([
      tx.branch.findUniqueOrThrow({ where: { id: member.homeBranchId } }),
      tx.membership.findMany({
        where: { memberId },
        include: {
          plan: true,
          branch: { select: { name: true } },
          freezes: { where: { endedAt: null } },
        },
        orderBy: { startDate: "desc" },
      }),
      tx.memberNote.findMany({
        where: { memberId, ...(seePrivate ? {} : { visibility: "STAFF" }) },
        orderBy: { createdAt: "desc" },
      }),
      tx.memberDocument.findMany({
        where: { memberId },
        include: { file: true },
        orderBy: { createdAt: "desc" },
      }),
      tx.contactConsent.findMany({
        where: { memberId },
        orderBy: { capturedAt: "desc" },
      }),
    ]);
    const authorIds = [...new Set(notes.map((n) => n.authorUserId))];
    const authors = authorIds.length
      ? await tx.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true },
        })
      : [];
    const authorName = new Map(authors.map((a) => [a.id, a.name]));
    return {
      member,
      homeBranch: branch,
      memberships,
      notes: notes.map((n) => ({
        ...n,
        authorName: authorName.get(n.authorUserId) ?? "Staff",
      })),
      canSeePrivateNotes: seePrivate,
      documents,
      consents,
      currentConsents: currentConsentState(consents),
    };
  });
}

export function currentConsentState(
  history: {
    channel: string;
    purpose: string;
    status: string;
    capturedAt: Date;
  }[],
) {
  const latest = new Map<string, { status: string; capturedAt: Date }>();
  for (const row of [...history].sort(
    (a, b) => a.capturedAt.getTime() - b.capturedAt.getTime(),
  )) {
    latest.set(`${row.channel}:${row.purpose}`, {
      status: row.status,
      capturedAt: row.capturedAt,
    });
  }
  const get = (channel: string, purpose: string) =>
    latest.get(`${channel}:${purpose}`)?.status === "GRANTED";
  return {
    serviceEmail: latest.get("EMAIL:SERVICE")?.status !== "REVOKED",
    serviceWhatsapp: latest.get("WHATSAPP:SERVICE")?.status !== "REVOKED",
    marketingEmail: get("EMAIL", "MARKETING"),
    marketingWhatsapp: get("WHATSAPP", "MARKETING"),
  };
}

// --- consents ---------------------------------------------------------------------------------

const consentChangeSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  purpose: z.enum(["SERVICE", "MARKETING"]),
  granted: checkbox,
  evidence: z.string().trim().max(300).optional(),
});

/** Appends to the consent history; opt-outs take effect for every later send (notify reads the latest row). */
export async function recordConsentTx(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  raw: unknown,
  by: { userId: string | null; method: "STAFF_FORM" | "SELF_SERVICE" },
) {
  const input = parseInput(consentChangeSchema, raw);
  return tx.contactConsent.create({
    data: {
      tenantId,
      memberId,
      channel: input.channel,
      purpose: input.purpose,
      status: input.granted ? "GRANTED" : "REVOKED",
      method: by.method,
      capturedByUserId: by.userId,
      evidence:
        input.evidence ??
        (input.purpose === "MARKETING"
          ? CONSENT_TEXT.MARKETING
          : CONSENT_TEXT.SERVICE),
    },
  });
}

export async function recordConsent(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  return inTenant(deps, ctx, async (tx) => {
    await loadMember(tx, ctx, memberId, "members.edit");
    const row = await recordConsentTx(tx, ctx.tenantId, memberId, raw, {
      userId: ctx.userId,
      method: "STAFF_FORM",
    });
    await recordAudit(tx, ctx, {
      action: "member.consent_changed",
      entityType: "MemberProfile",
      entityId: memberId,
      after: { channel: row.channel, purpose: row.purpose, status: row.status },
    });
    return row;
  });
}

// --- notes --------------------------------------------------------------------------------

const noteSchema = z.object({
  body: z.string().trim().min(1, "Write a note.").max(4000),
  visibility: z.enum(["STAFF", "MANAGEMENT"]).default("STAFF"),
});

export async function addMemberNote(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const input = parseInput(noteSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.edit");
    if (input.visibility === "MANAGEMENT") {
      requirePermission(ctx, "members.notes_private", {
        branchId: member.homeBranchId,
      });
    }
    return tx.memberNote.create({
      data: {
        tenantId: ctx.tenantId,
        memberId,
        authorUserId: ctx.userId,
        body: input.body,
        visibility: input.visibility,
      },
    });
  });
}

// --- documents ------------------------------------------------------------------------------

export const DOCUMENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Virus-scan hook. The stub marks files SKIPPED; plug in a real scanner (e.g. ClamAV) later. */
export type FileScanner = (
  key: string,
) => Promise<"CLEAN" | "INFECTED" | "SKIPPED">;
export const noScanner: FileScanner = async () => "SKIPPED";

const documentRequestSchema = z.object({
  contentType: z.enum(
    Object.keys(DOCUMENT_TYPES) as [keyof typeof DOCUMENT_TYPES],
  ),
  size: z
    .number()
    .int()
    .positive()
    .max(DOCUMENT_MAX_BYTES, "Documents must be 5 MB or smaller."),
  filename: z.string().trim().min(1).max(120),
});

export async function createDocumentUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const input = parseInput(documentRequestSchema, raw);
  await inTenant(deps, ctx, (tx) =>
    loadMember(tx, ctx, memberId, "members.edit"),
  );
  const key = `tenants/${ctx.tenantId}/members/${memberId}/${randomUUID()}.${DOCUMENT_TYPES[input.contentType]}`;
  const upload = await storage.createUpload({
    key,
    contentType: input.contentType,
    maxBytes: DOCUMENT_MAX_BYTES,
  });
  return { key, ...upload };
}

const confirmDocumentSchema = z.object({
  key: z.string().max(300),
  title: z.string().trim().min(1, "Give the document a title.").max(120),
  filename: z.string().trim().min(1).max(120),
});

export async function confirmDocumentUpload(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
  scan: FileScanner = noScanner,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const input = parseInput(confirmDocumentSchema, raw);
  const pattern = new RegExp(
    `^tenants/${ctx.tenantId}/members/${memberId}/[0-9a-f-]{36}\\.(pdf|jpg|png|webp)$`,
  );
  if (!pattern.test(input.key))
    throw new AppError(
      "FORBIDDEN",
      "That upload does not belong to this member.",
    );
  const head = await storage.head(input.key);
  if (!head)
    throw new AppError(
      "NOT_FOUND",
      "The upload did not arrive. Please try again.",
    );
  if (
    head.size > DOCUMENT_MAX_BYTES ||
    !head.contentType ||
    !(head.contentType in DOCUMENT_TYPES)
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Documents must be PDF, JPEG, PNG or WebP and at most 5 MB.",
    );
  }
  const scanStatus = await scan(input.key);
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.edit");
    const file = await tx.fileRecord.create({
      data: {
        tenantId: ctx.tenantId,
        key: input.key,
        filename: input.filename,
        contentType: head.contentType!,
        size: head.size,
        purpose: "MEMBER_DOCUMENT",
        scanStatus,
        uploadedByUserId: ctx.userId,
      },
    });
    const document = await tx.memberDocument.create({
      data: {
        tenantId: ctx.tenantId,
        memberId,
        fileId: file.id,
        title: input.title,
      },
    });
    await recordAudit(tx, ctx, {
      action: "member.document_added",
      entityType: "MemberDocument",
      entityId: document.id,
      branchId: member.homeBranchId,
      meta: { title: input.title, scanStatus },
    });
    return document;
  });
}

/** A 60-second download link, after the permission check. Infected files are never served. */
export async function documentDownloadUrl(
  deps: CoreDeps,
  storage: UploadStorage,
  ctx: AuthContext,
  documentId: string,
) {
  const document = await inTenant(deps, ctx, async (tx) => {
    const doc = await tx.memberDocument.findUnique({
      where: { id: documentId },
      include: { file: true },
    });
    if (!doc) throw new AppError("NOT_FOUND", "Document not found.");
    await loadMember(tx, ctx, doc.memberId, "members.view");
    await recordAudit(tx, ctx, {
      action: "member.document_downloaded",
      entityType: "MemberDocument",
      entityId: doc.id,
    });
    return doc;
  });
  if (document.file.scanStatus === "INFECTED")
    throw new AppError("FORBIDDEN", "This file failed the virus scan.");
  return storage.getUrl(document.file.key, 60);
}

// --- bulk actions -------------------------------------------------------------------------

const bulkSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign_branch"),
    memberIds: z.array(z.uuid()).min(1).max(500),
    branchId: z.uuid(),
  }),
  z.object({
    action: z.literal("add_tag"),
    memberIds: z.array(z.uuid()).min(1).max(500),
    tag: z.string().trim().min(1).max(30),
  }),
  z.object({
    action: z.literal("archive"),
    memberIds: z.array(z.uuid()).min(1).max(500),
  }),
  z.object({
    action: z.literal("restore"),
    memberIds: z.array(z.uuid()).min(1).max(500),
  }),
]);

/** Bulk actions apply to every member or none (one transaction); each member is permission-checked. */
export async function bulkUpdateMembers(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const ent = await guard(deps, ctx, {
    permission: "members.edit",
    write: true,
  });
  const input = parseInput(bulkSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const members = await tx.memberProfile.findMany({
      where: { id: { in: input.memberIds } },
    });
    if (members.length !== new Set(input.memberIds).size)
      throw new AppError("NOT_FOUND", "Some members were not found.");
    for (const m of members) {
      if (!hasPermission(ctx, "members.edit", { branchId: m.homeBranchId })) {
        throw new AppError("FORBIDDEN", `You can't edit ${memberName(m)}.`);
      }
    }
    let changed = 0;
    if (input.action === "assign_branch") {
      await assertBranchUsable(tx, ctx, input.branchId);
      changed = (
        await tx.memberProfile.updateMany({
          where: { id: { in: input.memberIds } },
          data: { homeBranchId: input.branchId },
        })
      ).count;
    } else if (input.action === "add_tag") {
      for (const m of members) {
        if (m.tags.includes(input.tag)) continue;
        await tx.memberProfile.update({
          where: { id: m.id },
          data: { tags: [...m.tags, input.tag] },
        });
        changed++;
      }
    } else if (input.action === "archive") {
      const active = members.filter((m) => m.status !== "ARCHIVED");
      const open = await tx.membership.count({
        where: {
          memberId: { in: active.map((m) => m.id) },
          status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
        },
      });
      if (open > 0)
        throw new AppError(
          "CONFLICT",
          "Some of these members have a running membership. Cancel or let it expire first.",
        );
      changed = (
        await tx.memberProfile.updateMany({
          where: { id: { in: active.map((m) => m.id) } },
          data: { status: "ARCHIVED", archivedAt: nowOf(deps) },
        })
      ).count;
      await bumpUsage(
        tx,
        ctx.tenantId,
        "members.max",
        -active.filter((m) => m.status === "ACTIVE").length,
      );
    } else {
      const archived = members.filter((m) => m.status === "ARCHIVED");
      await checkQuota(tx, ent, ctx.tenantId, "members.max", archived.length);
      changed = (
        await tx.memberProfile.updateMany({
          where: { id: { in: archived.map((m) => m.id) } },
          data: { status: "ACTIVE", archivedAt: null },
        })
      ).count;
      await bumpUsage(tx, ctx.tenantId, "members.max", archived.length);
    }
    await recordAudit(tx, ctx, {
      action: `member.bulk_${input.action}`,
      entityType: "MemberProfile",
      meta: {
        count: changed,
        memberIds: input.memberIds,
        ...("branchId" in input ? { branchId: input.branchId } : {}),
        ...("tag" in input ? { tag: input.tag } : {}),
      },
    });
    return { changed };
  });
}

// --- app invites and join requests ----------------------------------------------------------

export type MemberInviteMailer = (message: {
  to: string;
  name: string;
  tenantName: string;
  token: string;
}) => Promise<void>;

/** Emails the member a link to create their app account; accepting links it to this profile. */
export async function inviteMemberToApp(
  deps: CoreDeps,
  mailer: MemberInviteMailer,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const { token, tokenHash } = newInvitationToken();
  const result = await inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.edit");
    if (!member.email)
      throw new AppError("VALIDATION_FAILED", "Add the member's email first.");
    if (member.userId)
      throw new AppError("CONFLICT", "This member already has an app account.");
    if (member.status !== "ACTIVE")
      throw new AppError("CONFLICT", "Only active members can be invited.");
    await tx.invitation.updateMany({
      where: { memberId, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    await tx.invitation.create({
      data: {
        tenantId: ctx.tenantId,
        email: member.email,
        roles: [{ roleKey: "MEMBER", branchId: member.homeBranchId }],
        tokenHash,
        expiresAt: new Date(
          nowOf(deps).getTime() + INVITATION_TTL_DAYS * 86_400_000,
        ),
        invitedByUserId: ctx.userId,
        memberId,
      },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    await recordAudit(tx, ctx, {
      action: "member.app_invited",
      entityType: "MemberProfile",
      entityId: memberId,
      branchId: member.homeBranchId,
    });
    return {
      email: member.email,
      name: member.firstName,
      tenantName: tenant.displayName,
    };
  });
  await mailer({
    to: result.email,
    name: result.name,
    tenantName: result.tenantName,
    token,
  });
  return { sentTo: result.email };
}

/** /join/{slug}: tenant details for the join page, or null when the gym doesn't take self-signups. */
export async function findJoinableTenant(deps: CoreDeps, slug: string) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const rows = await deps.db.$queryRaw<
    { tenant_id: string; display_name: string; needs_approval: boolean }[]
  >`
    SELECT tenant_id::text, display_name, needs_approval FROM app.find_join_tenant(${slug})`;
  const row = rows[0];
  return row
    ? {
        tenantId: row.tenant_id,
        displayName: row.display_name,
        needsApproval: row.needs_approval,
      }
    : null;
}

/** The join page: the gym and its active branches, or null when the link is off. */
export async function getJoinPage(deps: CoreDeps, slug: string) {
  const tenant = await findJoinableTenant(deps, slug);
  if (!tenant) return null;
  const branches = await withTenant(deps.db, tenant.tenantId, (tx) =>
    tx.branch.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
  return { ...tenant, branches };
}

const joinSchema = z.object({
  phone: phoneSchema,
  homeBranchId: z.uuid("Pick a branch."),
  marketingEmail: checkbox,
  marketingWhatsapp: checkbox,
});

/**
 * Self-signup through the join link, for a signed-in user. Creates a pending member (or an active
 * one with app access when the gym doesn't require approval).
 */
export async function requestToJoin(
  deps: CoreDeps,
  user: { id: string; name: string; email: string; emailVerified: boolean },
  slug: string,
  raw: unknown,
) {
  if (!user.emailVerified)
    throw new AppError("FORBIDDEN", "Verify your email address first.");
  const tenant = await findJoinableTenant(deps, slug);
  if (!tenant)
    throw new AppError("NOT_FOUND", "This gym isn't taking sign-ups here.");
  const input = parseInput(joinSchema, raw);
  return withTenant(
    deps.db,
    tenant.tenantId,
    async (tx) => {
      const existing = await tx.memberProfile.findUnique({
        where: {
          tenantId_userId: { tenantId: tenant.tenantId, userId: user.id },
        },
      });
      if (existing)
        return {
          memberId: existing.id,
          status: existing.status,
          tenantId: tenant.tenantId,
        };
      const branch = await tx.branch.findUnique({
        where: { id: input.homeBranchId },
      });
      if (!branch || branch.status !== "ACTIVE")
        throw new AppError("VALIDATION_FAILED", "Pick a branch.");
      const [firstName, ...rest] = user.name.trim().split(/\s+/);
      const member = await tx.memberProfile.create({
        data: {
          tenantId: tenant.tenantId,
          homeBranchId: branch.id,
          userId: user.id,
          memberCode: await nextMemberCode(tx, tenant.tenantId),
          firstName: firstName || user.name,
          lastName: rest.join(" ") || null,
          email: user.email,
          phone: input.phone,
          source: "SELF_SIGNUP",
          status: tenant.needsApproval ? "PENDING_APPROVAL" : "ACTIVE",
        },
      });
      await recordConsentsAtOnboarding(
        tx,
        tenant.tenantId,
        member.id,
        null,
        "SIGNUP",
        {
          email: input.marketingEmail,
          whatsapp: input.marketingWhatsapp,
        },
      );
      if (!tenant.needsApproval) {
        await grantMemberAppAccess(
          tx,
          tenant.tenantId,
          member.id,
          user.id,
          branch.id,
        );
        await bumpUsage(tx, tenant.tenantId, "members.max", 1);
      } else {
        await notifyStaffOfJoinRequest(
          tx,
          tenant.tenantId,
          tenant.displayName,
          memberName(member),
        );
      }
      await recordAudit(
        tx,
        { userId: user.id, tenantId: tenant.tenantId },
        {
          action: "member.self_signup",
          entityType: "MemberProfile",
          entityId: member.id,
          branchId: branch.id,
          meta: { needsApproval: tenant.needsApproval },
        },
      );
      return {
        memberId: member.id,
        status: member.status,
        tenantId: tenant.tenantId,
      };
    },
    { userId: user.id },
  );
}

/** Membership + MEMBER role so the account can open the member app for this gym. */
export async function grantMemberAppAccess(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  userId: string,
  branchId: string,
) {
  const existing = await tx.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    include: { roles: true },
  });
  const membership = existing
    ? await tx.tenantMembership.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", deactivatedAt: null },
      })
    : await tx.tenantMembership.create({ data: { tenantId, userId } });
  if (!existing?.roles.some((r) => r.roleKey === "MEMBER")) {
    await tx.roleAssignment.create({
      data: {
        tenantId,
        membershipId: membership.id,
        roleKey: "MEMBER",
        branchId,
      },
    });
  }
  await tx.memberProfile.update({ where: { id: memberId }, data: { userId } });
}

async function notifyStaffOfJoinRequest(
  tx: TenantTransaction,
  tenantId: string,
  gym: string,
  name: string,
) {
  const admins = await tx.roleAssignment.findMany({
    where: {
      roleKey: { in: ["GYM_OWNER", "GYM_ADMIN"] },
      membership: { status: "ACTIVE" },
    },
    include: { membership: { select: { userId: true } } },
  });
  for (const userId of new Set(admins.map((a) => a.membership.userId))) {
    await notify(tx, tenantId, {
      templateKey: "member.join_requested",
      recipient: { userId },
      data: { name, gym },
      link: "/members?status=PENDING_APPROVAL",
      channels: ["IN_APP"],
    });
  }
}

export async function decideJoinRequest(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  approve: boolean,
) {
  const ent = await guard(deps, ctx, {
    permission: "members.edit",
    write: true,
  });
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId, "members.edit");
    if (member.status !== "PENDING_APPROVAL")
      throw new AppError("CONFLICT", "This request was already handled.");
    if (approve) {
      await checkQuota(tx, ent, ctx.tenantId, "members.max", 1);
      await tx.memberProfile.update({
        where: { id: memberId },
        data: { status: "ACTIVE" },
      });
      if (member.userId)
        await grantMemberAppAccess(
          tx,
          ctx.tenantId,
          memberId,
          member.userId,
          member.homeBranchId,
        );
      await bumpUsage(tx, ctx.tenantId, "members.max", 1);
    } else {
      await tx.memberProfile.update({
        where: { id: memberId },
        data: { status: "ARCHIVED", archivedAt: nowOf(deps), userId: null },
      });
    }
    await recordAudit(tx, ctx, {
      action: approve ? "member.join_approved" : "member.join_declined",
      entityType: "MemberProfile",
      entityId: memberId,
      branchId: member.homeBranchId,
    });
    return { approved: approve };
  });
}
