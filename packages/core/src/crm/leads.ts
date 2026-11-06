import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import { emitEvent } from "../events";
import { findDuplicates, memberName, normalizePhone } from "../members/service";
import { notify } from "../notifications";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import {
  canMoveTo,
  categoryRank,
  firstContactDue,
  matchKind,
  mergeTouches,
  nextRoundRobin,
  normalizeEmail,
  scoreLead,
  sourceCodeFor,
  statusForCategory,
  type StageCategory,
  type Touch,
  type Utm,
} from "./rules";
import { crmGuard, ensureCrmDefaults, stageFor } from "./setup";

/** Who did it: a staff member, or the system (public form, API, import job). */
export type CrmActor = AuditActor & { userId?: string | null };

const userIdOf = (actor: CrmActor) =>
  "system" in actor ? null : (actor.userId ?? null);

export const leadName = (l: { firstName: string; lastName: string | null }) =>
  [l.firstName, l.lastName].filter(Boolean).join(" ");

// --- staff pickers ------------------------------------------------------------------------------

/** Roles that work leads (assignee and owner pickers; recipient choice, not access control). */
const CRM_ROLES = [
  "GYM_OWNER",
  "GYM_ADMIN",
  "BRANCH_MANAGER",
  "RECEPTIONIST",
  "SALES_STAFF",
];

/** Active staff who can be given leads at a branch (role at that branch or gym-wide). */
export async function crmStaff(
  tx: TenantTransaction,
  branchId: string | null,
  roles = CRM_ROLES,
) {
  const rows = await tx.tenantMembership.findMany({
    where: {
      status: "ACTIVE",
      roles: {
        some: {
          roleKey: { in: roles },
          ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : {}),
        },
      },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { userId: "asc" },
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    email: r.user.email,
  }));
}

async function assertAssignable(
  tx: TenantTransaction,
  branchId: string,
  userId: string,
) {
  const staff = await crmStaff(tx, branchId);
  if (!staff.some((s) => s.userId === userId))
    throw new AppError(
      "VALIDATION_FAILED",
      "That person can't take leads at this branch.",
      {
        fields: { ownerUserId: ["Pick someone who works this branch."] },
      },
    );
}

/**
 * Round-robin among the branch's Sales Staff (spec: "round-robin per branch among Sales Staff").
 * The cursor row is locked, so two leads arriving together go to different people.
 */
export async function roundRobinOwner(
  tx: TenantTransaction,
  tenantId: string,
  branchId: string,
) {
  const team = await crmStaff(tx, branchId, ["SALES_STAFF"]);
  if (team.length === 0) return null;
  await tx.$executeRaw`
    INSERT INTO app.lead_assignment_cursor (tenant_id, branch_id, updated_at)
    VALUES (${tenantId}::uuid, ${branchId}::uuid, now()) ON CONFLICT DO NOTHING`;
  const [cursor] = await tx.$queryRaw<{ last_user_id: string | null }[]>`
    SELECT last_user_id::text FROM app.lead_assignment_cursor
     WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`;
  const next = nextRoundRobin(
    team.map((t) => t.userId),
    cursor?.last_user_id ?? null,
  );
  await tx.leadAssignmentCursor.update({
    where: { tenantId_branchId: { tenantId, branchId } },
    data: { lastUserId: next },
  });
  return next;
}

// --- duplicates ---------------------------------------------------------------------------------

export async function findLeadDuplicates(
  tx: TenantTransaction,
  key: { phone: string | null; email: string | null },
  excludeLeadId?: string,
) {
  const or: Prisma.LeadWhereInput[] = [];
  if (key.phone) or.push({ phone: key.phone });
  if (key.email) or.push({ email: key.email });
  if (or.length === 0) return { leads: [], members: [] };
  const leads = await tx.lead.findMany({
    where: { OR: or, ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}) },
    include: { stage: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const members = await findDuplicates(tx, key);
  return {
    leads: leads.map((l) => ({
      id: l.id,
      name: leadName(l),
      status: l.status,
      stage: l.stage.name,
      match: matchKind(key, l),
    })),
    members: members.map((m) => ({ ...m, match: matchKind(key, m) })),
  };
}

// --- create ---------------------------------------------------------------------------------------

export type NewLead = {
  branchId: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  interest: string | null;
  sourceId: string | null;
  campaignId: string | null;
  utm: Utm;
  referrer: string | null;
  ownerUserId: string | null;
  captureFormId: string | null;
  consentText: string | null;
  marketingConsent: boolean;
  note: string | null;
};

type Via = Touch["via"];

/**
 * The one way a lead is created (staff, public form, API, import). For form/API/import, an open
 * lead with the same phone or email is treated as a repeat enquiry: its last touch moves, nothing
 * new is created. Returns the lead and whether it is new.
 */
export async function createLeadTx(
  tx: TenantTransaction,
  actor: CrmActor,
  tenantId: string,
  input: NewLead,
  via: Via,
  now: Date,
): Promise<{ lead: { id: string }; created: boolean }> {
  await ensureCrmDefaults(tx, tenantId);
  const source = input.sourceId
    ? await tx.leadSource.findUnique({ where: { id: input.sourceId } })
    : await tx.leadSource.findFirst({
        where: {
          code:
            sourceCodeFor(input.utm.source) ??
            (via === "FORM" || via === "API" ? "website" : "__none__"),
          archivedAt: null,
        },
      });
  if (input.sourceId && !source)
    throw new AppError("VALIDATION_FAILED", "Pick a source.", {
      fields: { sourceId: ["Pick a source."] },
    });
  const campaign = input.campaignId
    ? await tx.campaign.findUnique({ where: { id: input.campaignId } })
    : input.utm.campaign
      ? await tx.campaign.findFirst({
          where: {
            code: { equals: input.utm.campaign, mode: "insensitive" },
            archivedAt: null,
          },
        })
      : null;
  if (input.campaignId && !campaign)
    throw new AppError("VALIDATION_FAILED", "Pick a campaign.", {
      fields: { campaignId: ["Pick a campaign."] },
    });
  const touch: Touch = {
    at: now.toISOString(),
    via,
    sourceId: source?.id ?? null,
    campaignId: campaign?.id ?? null,
    utm: input.utm,
    referrer: input.referrer,
  };

  if (via !== "STAFF") {
    const repeat = await tx.lead.findFirst({
      where: {
        status: "OPEN",
        OR: [
          ...(input.phone ? [{ phone: input.phone }] : []),
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (repeat) {
      const touches = mergeTouches(
        {
          first: (repeat.firstTouch as Touch | null) ?? null,
          last: (repeat.lastTouch as Touch | null) ?? null,
        },
        touch,
      );
      await tx.lead.update({
        where: { id: repeat.id },
        data: {
          lastTouch: touches.last as unknown as Prisma.InputJsonValue,
          ...(input.consentText
            ? { consentText: input.consentText, consentAt: now }
            : {}),
          ...(input.marketingConsent ? { marketingConsent: true } : {}),
        },
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: repeat.id,
          type: "CAPTURE",
          body: `Enquired again (${via === "FORM" ? "website form" : via === "API" ? "website" : "import"})${input.interest ? `: ${input.interest}` : ""}`,
          meta: {
            utm: input.utm,
            campaignId: campaign?.id ?? null,
          } as Prisma.InputJsonValue,
          userId: userIdOf(actor),
        },
      });
      return { lead: repeat, created: false };
    }
  }

  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  let ownerUserId = input.ownerUserId;
  if (ownerUserId) await assertAssignable(tx, input.branchId, ownerUserId);
  const roundRobin = !ownerUserId && settings?.leadAssignment === "ROUND_ROBIN";
  const stage = await stageFor(tx, tenantId, "NEW");
  const lead = await tx.lead.create({
    data: {
      tenantId,
      branchId: input.branchId,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      interest: input.interest,
      sourceId: source?.id ?? null,
      campaignId: campaign?.id ?? null,
      utmSource: input.utm.source ?? null,
      utmMedium: input.utm.medium ?? null,
      utmCampaign: input.utm.campaign ?? null,
      utmTerm: input.utm.term ?? null,
      utmContent: input.utm.content ?? null,
      referrer: input.referrer,
      firstTouch: touch as unknown as Prisma.InputJsonValue,
      lastTouch: touch as unknown as Prisma.InputJsonValue,
      stageId: stage.id,
      ownerUserId,
      captureFormId: input.captureFormId,
      consentText: input.consentText,
      consentAt: input.consentText ? now : null,
      marketingConsent: input.marketingConsent,
      createdById: userIdOf(actor),
      score: scoreLead({
        sourcePoints: source?.points ?? 0,
        createdAt: now,
        now,
        responded: false,
        trialBooked: false,
        trialAttended: false,
        trialNoShow: false,
        category: "NEW",
      }).score,
    },
  });
  await tx.leadActivity.create({
    data: {
      tenantId,
      leadId: lead.id,
      type: "CAPTURE",
      body:
        via === "STAFF"
          ? `Added by staff${source ? ` (${source.name})` : ""}`
          : via === "FORM"
            ? "Enquiry from the website form"
            : via === "API"
              ? "Enquiry from the website"
              : "Imported",
      meta: {
        utm: input.utm,
        campaignId: campaign?.id ?? null,
        referrer: input.referrer,
      } as Prisma.InputJsonValue,
      userId: userIdOf(actor),
    },
  });
  if (input.note)
    await tx.leadActivity.create({
      data: {
        tenantId,
        leadId: lead.id,
        type: "NOTE",
        body: input.note,
        userId: userIdOf(actor),
      },
    });
  // Every new lead gets a first-contact task (SLA from settings).
  const task = await tx.followUpTask.create({
    data: {
      tenantId,
      branchId: input.branchId,
      kind: "FIRST_CONTACT",
      title: `First contact: ${leadName(input)}`,
      dueAt: firstContactDue(now, settings?.leadFirstContactMinutes ?? 15),
      assigneeUserId: ownerUserId,
      leadId: lead.id,
      createdById: userIdOf(actor),
    },
  });
  // Round-robin last: the branch's pointer row stays locked until commit, so take it as late as
  // possible (simultaneous enquiries for one branch then barely wait for each other).
  if (roundRobin) {
    ownerUserId = await roundRobinOwner(tx, tenantId, input.branchId);
    if (ownerUserId) {
      await tx.lead.update({ where: { id: lead.id }, data: { ownerUserId } });
      await tx.followUpTask.update({
        where: { id: task.id },
        data: { assigneeUserId: ownerUserId },
      });
    }
  }
  await emitEvent(tx, tenantId, "lead.created", {
    leadId: lead.id,
    branchId: input.branchId,
    via,
    sourceId: source?.id ?? null,
    campaignId: campaign?.id ?? null,
    ownerUserId,
  });
  await recordAudit(tx, actor, {
    action: "lead.created",
    entityType: "Lead",
    entityId: lead.id,
    branchId: input.branchId,
    after: {
      via,
      sourceId: source?.id ?? null,
      campaignId: campaign?.id ?? null,
      ownerUserId,
    },
  });
  return { lead, created: true };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);
const checkbox = z
  .union([
    z.literal("on"),
    z.literal("true"),
    z.literal("false"),
    z.boolean(),
    z.literal(""),
  ])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");
const optionalUuid = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.uuid().optional(),
);

export const contactSchema = z
  .object({
    firstName: z.string().trim().min(1, "Enter a first name.").max(60),
    lastName: optionalText(60),
    phone: z
      .string()
      .trim()
      .optional()
      .transform((v, c) => {
        if (!v) return null;
        const p = normalizePhone(v);
        if (!p)
          c.addIssue({
            code: "custom",
            message: "Enter a valid mobile number, e.g. 98765 43210.",
          });
        return p;
      }),
    email: z
      .string()
      .trim()
      .optional()
      .transform((v, c) => {
        if (!v) return null;
        const e = normalizeEmail(v);
        if (!e) c.addIssue({ code: "custom", message: "Enter a valid email." });
        return e;
      }),
    interest: optionalText(300),
  })
  .refine((v) => v.phone || v.email, {
    path: ["phone"],
    message: "Add a mobile number or an email.",
  });

const staffCreateSchema = contactSchema.and(
  z.object({
    branchId: z.uuid("Pick a branch."),
    sourceId: optionalUuid,
    campaignId: optionalUuid,
    ownerUserId: optionalUuid,
    note: optionalText(1000),
    /** The person agreed to be contacted about joining (staff ticks it after asking). */
    consent: checkbox,
    marketingConsent: checkbox,
    confirmDuplicate: checkbox,
  }),
);

export const STAFF_CONSENT_TEXT =
  "Agreed (to staff) to be contacted about joining the gym.";

/** Staff add a lead (walk-in, phone call). Duplicates must be confirmed. */
export async function createLead(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(staffCreateSchema, raw);
  await crmGuard(deps, ctx, "leads.manage", {
    write: true,
    branchId: input.branchId,
  });
  if (input.ownerUserId && input.ownerUserId !== ctx.userId)
    requirePermission(ctx, "leads.assign", { branchId: input.branchId });
  return inTenant(deps, ctx, async (tx) => {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
    });
    if (!branch || branch.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick a branch.", {
        fields: { branchId: ["Pick a branch."] },
      });
    if (!input.confirmDuplicate) {
      const dupes = await findLeadDuplicates(tx, input);
      if (dupes.leads.length || dupes.members.length)
        throw new AppError(
          "CONFLICT",
          "Someone with this mobile number or email is already here.",
          {
            details: { duplicates: dupes },
            fields: {
              phone: [
                "Possible duplicate. Open the existing record, or tick 'Add anyway'.",
              ],
            },
          },
        );
    }
    const { lead } = await createLeadTx(
      tx,
      ctx,
      ctx.tenantId,
      {
        branchId: input.branchId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email,
        interest: input.interest,
        sourceId: input.sourceId ?? null,
        campaignId: input.campaignId ?? null,
        utm: {},
        referrer: null,
        ownerUserId: input.ownerUserId ?? null,
        captureFormId: null,
        consentText: input.consent ? STAFF_CONSENT_TEXT : null,
        marketingConsent: input.marketingConsent,
        note: input.note,
      },
      "STAFF",
      nowOf(deps),
    );
    return lead;
  });
}

/** As-you-type duplicate check for the new-lead form. */
export async function checkLeadDuplicates(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.view");
  const { phone, email } = parseInput(
    z.object({ phone: z.string().optional(), email: z.string().optional() }),
    raw,
  );
  return inTenant(deps, ctx, (tx) =>
    findLeadDuplicates(tx, {
      phone: phone ? normalizePhone(phone) : null,
      email: normalizeEmail(email),
    }),
  );
}

// --- read ------------------------------------------------------------------------------------------

export const leadListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["OPEN", "WON", "LOST", "ALL"]).default("OPEN"),
  stageId: optionalUuid,
  category: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .enum([
        "NEW",
        "CONTACTED",
        "TRIAL_SCHEDULED",
        "TRIAL_ATTENDED",
        "OFFER_SENT",
        "WON",
        "LOST",
      ])
      .optional(),
  ),
  owner: z.string().max(40).optional(),
  sourceId: optionalUuid,
  campaignId: optionalUuid,
  branchId: optionalUuid,
  from: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  ),
  to: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  ),
  overdue: checkbox,
  sort: z.enum(["newest", "oldest", "score", "updated"]).default("newest"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type LeadListFilters = z.infer<typeof leadListSchema>;

/** Prisma filter for the list/board/export (branch access applied by the caller). */
export function leadWhere(
  ctx: Pick<AuthContext, "userId" | "grants">,
  f: LeadListFilters,
  range: { from?: Date; to?: Date },
): Prisma.LeadWhereInput {
  const allowed = allowedBranchIds(ctx, "leads.view");
  const and: Prisma.LeadWhereInput[] = [];
  if (allowed !== "ALL") and.push({ branchId: { in: allowed } });
  if (f.branchId) and.push({ branchId: f.branchId });
  if (f.status !== "ALL") and.push({ status: f.status });
  if (f.stageId) and.push({ stageId: f.stageId });
  if (f.category) and.push({ stage: { category: f.category } });
  if (f.owner === "me") and.push({ ownerUserId: ctx.userId });
  else if (f.owner === "none") and.push({ ownerUserId: null });
  else if (f.owner && /^[0-9a-f-]{36}$/.test(f.owner))
    and.push({ ownerUserId: f.owner });
  if (f.sourceId) and.push({ sourceId: f.sourceId });
  if (f.campaignId) and.push({ campaignId: f.campaignId });
  if (range.from) and.push({ createdAt: { gte: range.from } });
  if (range.to) and.push({ createdAt: { lt: range.to } });
  if (f.overdue)
    and.push({
      tasks: { some: { status: "OPEN", dueAt: { lt: new Date() } } },
    });
  if (f.q) {
    const q = f.q;
    const phone = normalizePhone(q);
    and.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q.toLowerCase() } },
        ...(phone
          ? [{ phone }]
          : [{ phone: { contains: q.replace(/\s/g, "") } }]),
      ],
    });
  }
  return { AND: and };
}

const PAGE = 25;

export async function listLeads(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  range: { from?: Date; to?: Date } = {},
) {
  await crmGuard(deps, ctx, "leads.view");
  const f = parseInput(leadListSchema, raw);
  const orderBy: Prisma.LeadOrderByWithRelationInput[] =
    f.sort === "score"
      ? [{ score: "desc" }, { createdAt: "desc" }]
      : f.sort === "oldest"
        ? [{ createdAt: "asc" }]
        : f.sort === "updated"
          ? [{ updatedAt: "desc" }]
          : [{ createdAt: "desc" }];
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const where = leadWhere(ctx, f, range);
    const now = nowOf(deps);
    const [total, rows] = [
      await tx.lead.count({ where }),
      await tx.lead.findMany({
        where,
        orderBy,
        skip: (f.page - 1) * PAGE,
        take: PAGE,
        include: {
          stage: true,
          source: true,
          campaign: { select: { id: true, name: true } },
          branch: { select: { id: true, name: true } },
          tasks: {
            where: { status: "OPEN" },
            orderBy: { dueAt: "asc" },
            take: 1,
          },
        },
      }),
    ];
    const owners = await userNames(
      tx,
      rows.map((r) => r.ownerUserId),
    );
    return {
      total,
      page: f.page,
      pageSize: PAGE,
      filters: f,
      rows: rows.map((r) => ({
        id: r.id,
        name: leadName(r),
        phone: r.phone,
        email: r.email,
        status: r.status,
        score: r.score,
        stage: {
          id: r.stage.id,
          name: r.stage.name,
          category: r.stage.category,
        },
        source: r.source?.name ?? null,
        campaign: r.campaign?.name ?? null,
        branch: r.branch.name,
        owner: r.ownerUserId
          ? (owners.get(r.ownerUserId) ?? "Former staff")
          : null,
        createdAt: r.createdAt,
        nextTask: r.tasks[0]
          ? {
              title: r.tasks[0].title,
              dueAt: r.tasks[0].dueAt,
              overdue: r.tasks[0].dueAt < now,
            }
          : null,
      })),
    };
  });
}

async function userNames(tx: TenantTransaction, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map<string, string>();
  const rows = await tx.tenantMembership.findMany({
    where: { userId: { in: unique } },
    include: { user: { select: { id: true, name: true } } },
  });
  return new Map(rows.map((r) => [r.userId, r.user.name]));
}

/** Kanban: open leads per live stage (newest first, capped), plus won/lost counts. */
export async function pipelineBoard(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.view");
  const f = parseInput(leadListSchema, { ...(raw as object), status: "ALL" });
  return inTenant(deps, ctx, async (tx) => {
    await ensureCrmDefaults(tx, ctx.tenantId);
    const stages = await tx.leadStage.findMany({
      where: { archivedAt: null },
      orderBy: { position: "asc" },
    });
    const base = leadWhere(
      ctx,
      { ...f, status: "ALL", stageId: undefined, category: undefined },
      {},
    );
    const since = new Date(nowOf(deps).getTime() - 30 * 86_400_000);
    const columns = [];
    for (const stage of stages) {
      const closed = stage.category === "WON" || stage.category === "LOST";
      const where: Prisma.LeadWhereInput = {
        AND: [
          base,
          { stageId: stage.id },
          closed ? { updatedAt: { gte: since } } : { status: "OPEN" },
        ],
      };
      const [count, leads] = [
        await tx.lead.count({ where }),
        await tx.lead.findMany({
          where,
          orderBy: closed
            ? { updatedAt: "desc" }
            : [{ score: "desc" }, { createdAt: "desc" }],
          take: closed ? 20 : 100,
          include: {
            tasks: {
              where: { status: "OPEN" },
              orderBy: { dueAt: "asc" },
              take: 1,
            },
          },
        }),
      ];
      columns.push({ stage, count, leads });
    }
    const owners = await userNames(
      tx,
      columns.flatMap((c) => c.leads.map((l) => l.ownerUserId)),
    );
    const now = nowOf(deps);
    return columns.map((c) => ({
      stage: {
        id: c.stage.id,
        name: c.stage.name,
        category: c.stage.category as StageCategory,
      },
      count: c.count,
      movable: canMoveTo(c.stage.category as StageCategory),
      leads: c.leads.map((l) => ({
        id: l.id,
        name: leadName(l),
        score: l.score,
        owner: l.ownerUserId ? (owners.get(l.ownerUserId) ?? null) : null,
        overdue: !!l.tasks[0] && l.tasks[0].dueAt < now,
        nextDue: l.tasks[0]?.dueAt ?? null,
      })),
    }));
  });
}

async function loadLead(
  tx: TenantTransaction,
  ctx: AuthContext,
  leadId: string,
  permission: "leads.view" | "leads.manage",
) {
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    include: { stage: true },
  });
  if (!lead) throw new AppError("NOT_FOUND", "Lead not found.");
  // Branch access: a branch-scoped user only sees their branch's leads (looks like not found).
  if (!hasPermission(ctx, "leads.view", { branchId: lead.branchId }))
    throw new AppError("NOT_FOUND", "Lead not found.");
  requirePermission(ctx, permission, { branchId: lead.branchId });
  return lead;
}

export async function getLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, async (tx) => {
    await loadLead(tx, ctx, leadId, "leads.view");
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: {
        stage: true,
        source: true,
        campaign: true,
        branch: { select: { id: true, name: true } },
        lostReason: true,
        captureForm: { select: { id: true, name: true } },
        convertedMember: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        activities: { orderBy: { createdAt: "desc" }, take: 200 },
        tasks: { orderBy: [{ status: "asc" }, { dueAt: "asc" }] },
        trials: {
          orderBy: { startsAt: "desc" },
          include: { classSession: { select: { id: true, name: true } } },
        },
      },
    });
    const people = await userNames(tx, [
      lead.ownerUserId,
      ...lead.activities.map((a) => a.userId),
      ...lead.tasks.map((t) => t.assigneeUserId),
    ]);
    const breakdown = await scoreTx(tx, lead.id, nowOf(deps));
    const duplicates = await findLeadDuplicates(tx, lead, lead.id);
    return {
      ...lead,
      name: leadName(lead),
      owner: lead.ownerUserId
        ? {
            userId: lead.ownerUserId,
            name: people.get(lead.ownerUserId) ?? "Former staff",
          }
        : null,
      firstTouch: lead.firstTouch as Touch | null,
      lastTouch: lead.lastTouch as Touch | null,
      activities: lead.activities.map((a) => ({
        ...a,
        user: a.userId ? (people.get(a.userId) ?? null) : null,
      })),
      tasks: lead.tasks.map((t) => ({
        ...t,
        assignee: t.assigneeUserId
          ? (people.get(t.assigneeUserId) ?? null)
          : null,
      })),
      score: breakdown,
      duplicates,
      convertedMember: lead.convertedMember
        ? { ...lead.convertedMember, name: memberName(lead.convertedMember) }
        : null,
      canManage: hasPermission(ctx, "leads.manage", {
        branchId: lead.branchId,
      }),
      canAssign: hasPermission(ctx, "leads.assign", {
        branchId: lead.branchId,
      }),
    };
  });
}

// --- scoring ------------------------------------------------------------------------------------------

/** Recomputes from the lead's facts and stores the total (the breakdown is shown on the lead). */
export async function scoreTx(
  tx: TenantTransaction,
  leadId: string,
  now: Date,
) {
  const lead = await tx.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: { stage: true, source: true, trials: true },
  });
  const responded =
    (await tx.leadActivity.count({
      where: {
        leadId,
        OR: [
          { type: "MEETING" },
          { type: "CALL", meta: { path: ["outcome"], equals: "ANSWERED" } },
        ],
      },
    })) > 0;
  const result = scoreLead({
    sourcePoints: lead.source?.points ?? 0,
    createdAt: lead.createdAt,
    now,
    responded,
    trialBooked: lead.trials.some((t) => t.status !== "CANCELLED"),
    trialAttended: lead.trials.some((t) => t.status === "ATTENDED"),
    trialNoShow: lead.trials.some((t) => t.status === "NO_SHOW"),
    category: lead.stage.category as StageCategory,
  });
  if (result.score !== lead.score)
    await tx.lead.update({
      where: { id: leadId },
      data: { score: result.score },
    });
  return result;
}

// --- stage, assignment, activity -------------------------------------------------------------------

/**
 * Moves a lead to a stage and records it (activity + event). Used by the board and by automatic
 * moves (trial booked/attended/no-show, first contact). `onlyForward` skips moves that would go
 * back in the funnel (automatic moves never undo a staff decision).
 */
export async function moveToStageTx(
  tx: TenantTransaction,
  actor: CrmActor,
  tenantId: string,
  lead: { id: string; stageId: string; branchId: string },
  target: { id: string; name: string; category: string },
  options: {
    onlyForward?: boolean;
    reason?: string;
    /** Written in the same UPDATE as the status (won/lost dates must agree with it). */
    extra?: Prisma.LeadUncheckedUpdateInput;
  } = {},
) {
  const from = await tx.leadStage.findUniqueOrThrow({
    where: { id: lead.stageId },
  });
  if (from.id === target.id) return false;
  if (
    options.onlyForward &&
    categoryRank(target.category as StageCategory) <=
      categoryRank(from.category as StageCategory)
  )
    return false;
  const status = statusForCategory(target.category as StageCategory);
  await tx.lead.update({
    where: { id: lead.id },
    data: { ...options.extra, stageId: target.id, status },
  });
  await tx.leadActivity.create({
    data: {
      tenantId,
      leadId: lead.id,
      type: "STAGE_CHANGE",
      body: `${from.name} → ${target.name}${options.reason ? ` (${options.reason})` : ""}`,
      meta: {
        from: from.id,
        to: target.id,
        fromCategory: from.category,
        toCategory: target.category,
      },
      userId: userIdOf(actor),
    },
  });
  await emitEvent(tx, tenantId, "lead.stage_changed", {
    leadId: lead.id,
    fromStageId: from.id,
    toStageId: target.id,
    fromCategory: from.category,
    toCategory: target.category,
  });
  return true;
}

/** Board drag / stage picker. Won comes only from a paid membership; Lost needs a reason. */
export async function moveLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const { stageId } = parseInput(
    z.object({ stageId: z.uuid("Pick a stage.") }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    if (lead.status !== "OPEN")
      throw new AppError("CONFLICT", "Reopen the lead before moving it.");
    const target = await tx.leadStage.findUnique({ where: { id: stageId } });
    if (!target || target.archivedAt)
      throw new AppError("NOT_FOUND", "Stage not found.");
    if (!canMoveTo(target.category as StageCategory))
      throw new AppError(
        "VALIDATION_FAILED",
        target.category === "WON"
          ? "A lead is won when their membership is paid. Use 'Convert to member'."
          : "Use 'Mark as lost' and give a reason.",
      );
    await moveToStageTx(tx, ctx, ctx.tenantId, lead, target);
    await scoreTx(tx, lead.id, nowOf(deps));
    await recordAudit(tx, ctx, {
      action: "lead.stage_changed",
      entityType: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
      before: { stageId: lead.stageId },
      after: { stageId: target.id },
    });
  });
}

export async function assignLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const { ownerUserId } = parseInput(
    z.object({
      ownerUserId: z.preprocess(
        (v) => (v === "" || v === "none" ? null : v),
        z.uuid().nullable(),
      ),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    // Taking an unowned lead yourself needs leads.manage; anything else needs leads.assign.
    const selfClaim = ownerUserId === ctx.userId && !lead.ownerUserId;
    if (!selfClaim)
      requirePermission(ctx, "leads.assign", { branchId: lead.branchId });
    if (lead.ownerUserId === ownerUserId) return;
    if (ownerUserId) await assertAssignable(tx, lead.branchId, ownerUserId);
    await reassignTx(tx, ctx, ctx.tenantId, lead, ownerUserId, false);
  });
}

async function reassignTx(
  tx: TenantTransaction,
  actor: CrmActor,
  tenantId: string,
  lead: {
    id: string;
    ownerUserId: string | null;
    branchId: string;
    firstName: string;
    lastName: string | null;
  },
  toUserId: string | null,
  automatic: boolean,
) {
  await tx.lead.update({
    where: { id: lead.id },
    data: { ownerUserId: toUserId },
  });
  // Open tasks of the previous owner (or unassigned) follow the lead.
  await tx.followUpTask.updateMany({
    where: {
      leadId: lead.id,
      status: "OPEN",
      OR: [{ assigneeUserId: lead.ownerUserId }, { assigneeUserId: null }],
    },
    data: { assigneeUserId: toUserId },
  });
  const names = await userNames(tx, [lead.ownerUserId, toUserId]);
  await tx.leadActivity.create({
    data: {
      tenantId,
      leadId: lead.id,
      type: "ASSIGNMENT",
      body: toUserId
        ? `Given to ${names.get(toUserId) ?? "staff"}`
        : "Unassigned",
      meta: { from: lead.ownerUserId, to: toUserId, automatic },
      userId: userIdOf(actor),
    },
  });
  await emitEvent(tx, tenantId, "lead.assigned", {
    leadId: lead.id,
    fromUserId: lead.ownerUserId,
    toUserId,
    automatic,
  });
  await recordAudit(tx, actor, {
    action: "lead.assigned",
    entityType: "Lead",
    entityId: lead.id,
    branchId: lead.branchId,
    before: { ownerUserId: lead.ownerUserId },
    after: { ownerUserId: toUserId },
  });
  if (toUserId && toUserId !== userIdOf(actor))
    await notify(tx, tenantId, {
      templateKey: "lead.assigned",
      recipient: { userId: toUserId },
      channels: ["IN_APP"],
      data: { lead: leadName(lead) },
      link: `/leads/${lead.id}`,
    });
}

export const CALL_OUTCOMES = [
  "ANSWERED",
  "NO_ANSWER",
  "BUSY",
  "CALL_BACK",
  "WRONG_NUMBER",
] as const;

const activitySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("NOTE"),
    body: z.string().trim().min(1, "Write the note.").max(2000),
  }),
  z.object({
    type: z.literal("CALL"),
    outcome: z.enum(CALL_OUTCOMES),
    body: z.string().trim().max(2000).optional(),
  }),
  z.object({
    type: z.literal("EMAIL"),
    body: z.string().trim().min(1, "What was it about?").max(2000),
  }),
  z.object({
    type: z.literal("MEETING"),
    body: z.string().trim().max(2000).optional(),
  }),
]);

/**
 * Logs a call, note, email or meeting. Contact (call/email/meeting) closes the first-contact task,
 * stamps first/last contact, and moves a NEW lead to CONTACTED.
 */
export async function logLeadActivity(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const input = parseInput(activitySchema, raw);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    await tx.leadActivity.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: lead.id,
        type: input.type,
        body: input.body || null,
        meta: input.type === "CALL" ? { outcome: input.outcome } : undefined,
        userId: ctx.userId,
      },
    });
    if (input.type !== "NOTE") {
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          lastContactedAt: now,
          ...(lead.firstContactedAt ? {} : { firstContactedAt: now }),
        },
      });
      await tx.followUpTask.updateMany({
        where: { leadId: lead.id, kind: "FIRST_CONTACT", status: "OPEN" },
        data: {
          status: "DONE",
          completedAt: now,
          completedById: ctx.userId,
          outcome: input.type === "CALL" ? input.outcome : input.type,
        },
      });
      if (lead.status === "OPEN" && lead.stage.category === "NEW")
        await moveToStageTx(
          tx,
          ctx,
          ctx.tenantId,
          lead,
          await stageFor(tx, ctx.tenantId, "CONTACTED"),
          {
            onlyForward: true,
            reason: "first contact",
          },
        );
    }
    await scoreTx(tx, lead.id, now);
  });
}

export async function updateLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const input = parseInput(
    contactSchema.and(
      z.object({
        sourceId: optionalUuid,
        campaignId: optionalUuid,
        marketingConsent: checkbox,
      }),
    ),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    if (
      input.sourceId &&
      !(await tx.leadSource.findUnique({ where: { id: input.sourceId } }))
    )
      throw new AppError("VALIDATION_FAILED", "Pick a source.");
    if (
      input.campaignId &&
      !(await tx.campaign.findUnique({ where: { id: input.campaignId } }))
    )
      throw new AppError("VALIDATION_FAILED", "Pick a campaign.");
    const after = {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      interest: input.interest,
      sourceId: input.sourceId ?? null,
      campaignId: input.campaignId ?? null,
      marketingConsent: input.marketingConsent,
    };
    // A staff correction of source/campaign corrects the attribution: the latest touch always,
    // and the first touch too while there has only been one enquiry.
    const fix = (t: Touch | null) =>
      t
        ? ({
            ...t,
            sourceId: after.sourceId,
            campaignId: after.campaignId,
          } as unknown as Prisma.InputJsonValue)
        : undefined;
    const first = lead.firstTouch as Touch | null;
    const last = lead.lastTouch as Touch | null;
    const changed =
      after.sourceId !== lead.sourceId || after.campaignId !== lead.campaignId;
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...after,
        ...(changed
          ? {
              lastTouch: fix(last),
              ...(first && last && first.at === last.at
                ? { firstTouch: fix(first) }
                : {}),
            }
          : {}),
      },
    });
    await scoreTx(tx, lead.id, nowOf(deps));
    await recordAudit(tx, ctx, {
      action: "lead.updated",
      entityType: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
      before: {
        sourceId: lead.sourceId,
        campaignId: lead.campaignId,
        marketingConsent: lead.marketingConsent,
      },
      after: {
        sourceId: after.sourceId,
        campaignId: after.campaignId,
        marketingConsent: after.marketingConsent,
      },
    });
  });
}

/** Lost needs a reason; open tasks close, booked trials are cancelled. */
export async function markLeadLost(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const input = parseInput(
    z.object({
      lostReasonId: z.uuid("Pick a reason."),
      note: z
        .string()
        .trim()
        .max(500)
        .optional()
        .transform((v) => v || null),
    }),
    raw,
  );
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    if (lead.status !== "OPEN")
      throw new AppError("CONFLICT", "This lead is already closed.");
    const reason = await tx.lostReason.findUnique({
      where: { id: input.lostReasonId },
    });
    if (!reason || reason.archivedAt)
      throw new AppError("VALIDATION_FAILED", "Pick a reason.", {
        fields: { lostReasonId: ["Pick a reason."] },
      });
    const lostStage = await stageFor(tx, ctx.tenantId, "LOST");
    await moveToStageTx(tx, ctx, ctx.tenantId, lead, lostStage, {
      reason: reason.name,
      extra: { lostReasonId: reason.id, lostNote: input.note, lostAt: now },
    });
    await tx.followUpTask.updateMany({
      where: { leadId: lead.id, status: "OPEN" },
      data: {
        status: "CANCELLED",
        completedAt: now,
        completedById: ctx.userId,
        outcome: "Lead lost",
      },
    });
    await releaseTrialsTx(tx, ctx.tenantId, lead.id, now);
    await emitEvent(tx, ctx.tenantId, "lead.lost", {
      leadId: lead.id,
      lostReasonId: reason.id,
    });
    await recordAudit(tx, ctx, {
      action: "lead.lost",
      entityType: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
      after: { lostReasonId: reason.id },
      meta: { note: input.note },
    });
  });
}

/** Cancels a lead's booked trials, giving class seats back. */
export async function releaseTrialsTx(
  tx: TenantTransaction,
  tenantId: string,
  leadId: string,
  now: Date,
) {
  const trials = await tx.trialBooking.findMany({
    where: { leadId, status: "BOOKED" },
  });
  for (const t of trials) {
    await tx.trialBooking.update({
      where: { id: t.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    if (t.classSessionId)
      await tx.$executeRaw`UPDATE app.class_session SET booked_count = booked_count - 1 WHERE id = ${t.classSessionId}::uuid AND booked_count > 0`;
    await emitEvent(tx, tenantId, "trial.cancelled", { trialId: t.id, leadId });
  }
}

export async function reopenLead(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const lead = await loadLead(tx, ctx, leadId, "leads.manage");
    if (lead.status !== "LOST")
      throw new AppError("CONFLICT", "Only lost leads can be reopened.");
    await moveToStageTx(
      tx,
      ctx,
      ctx.tenantId,
      lead,
      await stageFor(tx, ctx.tenantId, "CONTACTED"),
      {
        reason: "reopened",
        extra: { lostReasonId: null, lostNote: null, lostAt: null },
      },
    );
    await recordAudit(tx, ctx, {
      action: "lead.reopened",
      entityType: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
    });
  });
}

// --- saved views --------------------------------------------------------------------------------------

export async function listSavedViews(deps: CoreDeps, ctx: AuthContext) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, (tx) =>
    tx.leadSavedView.findMany({
      where: { OR: [{ userId: ctx.userId }, { shared: true }] },
      orderBy: { name: "asc" },
    }),
  );
}

export async function saveView(deps: CoreDeps, ctx: AuthContext, raw: unknown) {
  await crmGuard(deps, ctx, "leads.view", { write: true });
  const input = parseInput(
    z.object({
      name: z.string().trim().min(2, "Name the view.").max(40),
      filters: z.record(z.string(), z.unknown()),
      shared: checkbox,
    }),
    raw,
  );
  const filters = leadListSchema.omit({ page: true }).parse(input.filters);
  if (input.shared) requirePermission(ctx, "leads.assign");
  return inTenant(deps, ctx, (tx) =>
    tx.leadSavedView.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        name: input.name,
        filters: filters as Prisma.InputJsonValue,
        shared: input.shared,
      },
    }),
  );
}

export async function deleteView(
  deps: CoreDeps,
  ctx: AuthContext,
  viewId: string,
) {
  await crmGuard(deps, ctx, "leads.view", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const view = await tx.leadSavedView.findUnique({ where: { id: viewId } });
    if (!view) throw new AppError("NOT_FOUND", "View not found.");
    if (view.userId !== ctx.userId) requirePermission(ctx, "leads.assign");
    await tx.leadSavedView.delete({ where: { id: view.id } });
  });
}

/** People a lead or task can be given to at a branch (for pickers). */
export async function crmStaffOptions(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId: string | null,
) {
  await crmGuard(deps, ctx, "leads.view");
  return inTenant(deps, ctx, (tx) => crmStaff(tx, branchId));
}

export { reassignTx };
