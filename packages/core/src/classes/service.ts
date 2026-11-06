import { inOrder, type Prisma, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import { memberName } from "../members/service";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  compareDates,
  formatClock,
  fromDbDate,
  isLocalDate,
  localMinuteOf,
  localTimeToUtc,
  parseClock,
  startOfDayUtc,
  todayIn,
  toDbDate,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import {
  availabilityFor,
  cancelCutoffAt,
  findConflicts,
  occurrencesBetween,
  toRRule,
  type AvailabilityRow,
  type Busy,
  type Conflict,
} from "./rules";

/** Sessions are materialized this many days ahead (8 weeks). */
export const MATERIALIZE_DAYS = 56;

const CLASSES = "classes.enabled" as const;

// --- categories and rooms -------------------------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(2, "Give it a name.").max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour.")
    .default("#204289"),
});

export async function listCategories(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "classes.view" });
  return inTenant(deps, ctx, (tx) =>
    tx.classCategory.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  );
}

export async function createCategory(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "classes.manage",
    write: true,
    entitlement: CLASSES,
  });
  const input = parseInput(categorySchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const clash = await tx.classCategory.findFirst({
      where: { name: { equals: input.name, mode: "insensitive" } },
    });
    if (clash)
      throw new AppError("CONFLICT", "That category already exists.", {
        fields: { name: ["Already exists."] },
      });
    const category = await tx.classCategory.create({
      data: { tenantId: ctx.tenantId, ...input },
    });
    await recordAudit(tx, ctx, {
      action: "class_category.created",
      entityType: "ClassCategory",
      entityId: category.id,
      after: input,
    });
    return category;
  });
}

const roomSchema = z.object({
  branchId: z.uuid("Pick a branch."),
  name: z.string().trim().min(1, "Give it a name.").max(60),
  capacity: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().int().positive().max(1000).nullable(),
  ),
});

export async function listRooms(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId?: string,
) {
  await guard(deps, ctx, { permission: "classes.view" });
  const allowed = allowedBranchIds(ctx, "classes.view");
  return inTenant(deps, ctx, (tx) =>
    tx.room.findMany({
      where: {
        status: "ACTIVE",
        ...(branchId
          ? { branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      orderBy: [{ branchId: "asc" }, { name: "asc" }],
      include: { branch: { select: { name: true } } },
    }),
  );
}

export async function createRoom(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(roomSchema, raw);
  await guard(deps, ctx, {
    permission: "classes.manage",
    branchId: input.branchId,
    write: true,
    entitlement: CLASSES,
  });
  return inTenant(deps, ctx, async (tx) => {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
    });
    if (!branch || branch.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick an active branch.");
    const clash = await tx.room.findFirst({
      where: { branchId: input.branchId, name: input.name },
    });
    if (clash)
      throw new AppError("CONFLICT", "That room already exists here.", {
        fields: { name: ["Already exists at this branch."] },
      });
    const room = await tx.room.create({
      data: { tenantId: ctx.tenantId, ...input },
    });
    await recordAudit(tx, ctx, {
      action: "room.created",
      entityType: "Room",
      entityId: room.id,
      branchId: room.branchId,
      after: input,
    });
    return room;
  });
}

// --- templates ------------------------------------------------------------------------------

const optionalUuid = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z.uuid().nullable(),
);
const optionalInt = (max: number) =>
  z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().int().positive().max(max).nullable(),
  );
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const days = z.preprocess(
  (v) =>
    (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]).map(Number),
  z
    .array(z.number().int().min(1).max(7))
    .min(1, "Pick at least one day.")
    .max(7),
);

export const templateSchema = z
  .object({
    branchId: z.uuid("Pick a branch."),
    name: z.string().trim().min(2, "Give the class a name.").max(80),
    description: z.string().trim().max(1000).optional(),
    categoryId: optionalUuid,
    trainerId: optionalUuid,
    roomId: optionalUuid,
    capacity: z.coerce.number().int().positive("At least 1 place.").max(500),
    durationMinutes: z.coerce.number().int().min(10).max(480),
    startTime: clock,
    byDays: days,
    startDate: z.string().refine(isLocalDate, "Pick a start date."),
    untilDate: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().refine(isLocalDate, "Pick a valid date.").optional(),
    ),
    occurrenceCount: optionalInt(500),
    eligiblePlanCodes: z.preprocess(
      (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
      z.array(z.string().trim().min(1).max(40)).max(50),
    ),
    bookingOpensHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(168),
    bookingClosesMinutes: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(0),
    cancelCutoffMinutes: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .default(120),
    waitlistEnabled: z
      .union([z.boolean(), z.literal("on"), z.literal("")])
      .optional()
      .transform((v) => v === true || v === "on"),
    waitlistMax: optionalInt(500),
  })
  .refine((v) => !(v.untilDate && v.occurrenceCount), {
    message: "Use an end date or a number of classes, not both.",
    path: ["untilDate"],
  })
  .refine((v) => !v.untilDate || compareDates(v.untilDate, v.startDate) >= 0, {
    message: "The end date is before the start date.",
    path: ["untilDate"],
  });

async function checkTemplateRefs(
  tx: TenantTransaction,
  input: z.infer<typeof templateSchema>,
) {
  const [branch, category, trainer, room] = await inOrder([
    tx.branch.findUnique({ where: { id: input.branchId } }),
    input.categoryId
      ? tx.classCategory.findUnique({ where: { id: input.categoryId } })
      : Promise.resolve(null),
    input.trainerId
      ? tx.trainerProfile.findUnique({ where: { id: input.trainerId } })
      : Promise.resolve(null),
    input.roomId
      ? tx.room.findUnique({ where: { id: input.roomId } })
      : Promise.resolve(null),
  ]);
  if (!branch || branch.status !== "ACTIVE")
    throw new AppError("VALIDATION_FAILED", "Pick an active branch.", {
      fields: { branchId: ["Pick an active branch."] },
    });
  if (input.categoryId && (!category || category.status !== "ACTIVE"))
    throw new AppError("VALIDATION_FAILED", "Pick a category.", {
      fields: { categoryId: ["Pick a category."] },
    });
  if (input.trainerId && (!trainer || trainer.status !== "ACTIVE"))
    throw new AppError("VALIDATION_FAILED", "Pick an active trainer.", {
      fields: { trainerId: ["Pick an active trainer."] },
    });
  if (input.roomId && (!room || room.branchId !== input.branchId))
    throw new AppError("VALIDATION_FAILED", "Pick a room at this branch.", {
      fields: { roomId: ["Pick a room at this branch."] },
    });
  if (room?.capacity && input.capacity > room.capacity)
    throw new AppError(
      "VALIDATION_FAILED",
      `The room holds ${room.capacity} people.`,
      { fields: { capacity: [`At most ${room.capacity} for this room.`] } },
    );
  return { branch };
}

function templateData(input: z.infer<typeof templateSchema>) {
  return {
    branchId: input.branchId,
    name: input.name,
    description: input.description || null,
    categoryId: input.categoryId,
    trainerId: input.trainerId,
    roomId: input.roomId,
    capacity: input.capacity,
    durationMinutes: input.durationMinutes,
    startMinute: parseClock(input.startTime),
    byDays: [...new Set(input.byDays)].sort(),
    startDate: toDbDate(input.startDate),
    untilDate: input.untilDate ? toDbDate(input.untilDate) : null,
    occurrenceCount: input.occurrenceCount,
    eligiblePlanCodes: input.eligiblePlanCodes,
    bookingOpensHours: input.bookingOpensHours,
    bookingClosesMinutes: input.bookingClosesMinutes,
    cancelCutoffMinutes: input.cancelCutoffMinutes,
    waitlistEnabled: input.waitlistEnabled,
    waitlistMax: input.waitlistMax,
  };
}

export async function createClassTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(templateSchema, raw);
  await guard(deps, ctx, {
    permission: "classes.manage",
    branchId: input.branchId,
    write: true,
    entitlement: CLASSES,
  });
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    await checkTemplateRefs(tx, input);
    const template = await tx.classTemplate.create({
      data: {
        tenantId: ctx.tenantId,
        ...templateData(input),
        createdById: ctx.userId,
      },
    });
    const result = await materializeTemplate(
      tx,
      ctx.tenantId,
      template.id,
      today,
      now,
    );
    await recordAudit(tx, ctx, {
      action: "class_template.created",
      entityType: "ClassTemplate",
      entityId: template.id,
      branchId: template.branchId,
      after: { ...input, rrule: rruleOf(template) },
    });
    return { template, ...result };
  });
}

export async function updateClassTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string,
  raw: unknown,
) {
  const input = parseInput(templateSchema, raw);
  await guard(deps, ctx, {
    permission: "classes.manage",
    branchId: input.branchId,
    write: true,
    entitlement: CLASSES,
  });
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    const existing = await tx.classTemplate.findUnique({
      where: { id: templateId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Class not found.");
    requirePermission(ctx, "classes.manage", { branchId: existing.branchId });
    if (existing.branchId !== input.branchId)
      throw new AppError(
        "VALIDATION_FAILED",
        "A class can't move to another branch. Archive it and create a new one there.",
      );
    await checkTemplateRefs(tx, input);
    const template = await tx.classTemplate.update({
      where: { id: templateId },
      data: { ...templateData(input), version: { increment: 1 } },
    });
    const result = await materializeTemplate(
      tx,
      ctx.tenantId,
      template.id,
      today,
      now,
    );
    await recordAudit(tx, ctx, {
      action: "class_template.updated",
      entityType: "ClassTemplate",
      entityId: template.id,
      branchId: template.branchId,
      before: { rrule: rruleOf(existing), version: existing.version },
      after: { ...input, rrule: rruleOf(template), version: template.version },
      meta: { conflicts: result.flagged },
    });
    return { template, ...result };
  });
}

export async function archiveClassTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string,
) {
  await guard(deps, ctx, { permission: "classes.manage", write: true });
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    const existing = await tx.classTemplate.findUnique({
      where: { id: templateId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Class not found.");
    requirePermission(ctx, "classes.manage", { branchId: existing.branchId });
    await tx.classTemplate.update({
      where: { id: templateId },
      data: { status: "ARCHIVED", version: { increment: 1 } },
    });
    const result = await materializeTemplate(
      tx,
      ctx.tenantId,
      templateId,
      today,
      now,
    );
    await recordAudit(tx, ctx, {
      action: "class_template.archived",
      entityType: "ClassTemplate",
      entityId: templateId,
      branchId: existing.branchId,
      meta: {
        removedSessions: result.removed,
        keptWithBookings: result.flagged,
      },
    });
    return result;
  });
}

function rruleOf(t: {
  byDays: number[];
  startDate: Date;
  untilDate: Date | null;
  occurrenceCount: number | null;
}) {
  return toRRule({
    byDays: t.byDays,
    startDate: fromDbDate(t.startDate),
    untilDate: t.untilDate ? fromDbDate(t.untilDate) : null,
    count: t.occurrenceCount,
  });
}

export async function listClassTemplates(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { branchId?: string; includeArchived?: boolean } = {},
) {
  await guard(deps, ctx, { permission: "classes.view" });
  const allowed = allowedBranchIds(ctx, "classes.view");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.classTemplate.findMany({
      where: {
        ...(options.includeArchived ? {} : { status: "ACTIVE" }),
        ...(options.branchId
          ? { branchId: options.branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      orderBy: [{ name: "asc" }],
      include: {
        branch: { select: { name: true } },
        category: { select: { name: true, color: true } },
        trainer: { select: { displayName: true } },
        room: { select: { name: true } },
      },
    });
    return rows.map((t) => ({
      ...t,
      startTime: formatClock(t.startMinute),
      rrule: rruleOf(t),
      startDate: fromDbDate(t.startDate),
      untilDate: t.untilDate ? fromDbDate(t.untilDate) : null,
    }));
  });
}

export async function getClassTemplate(
  deps: CoreDeps,
  ctx: AuthContext,
  templateId: string,
) {
  await guard(deps, ctx, { permission: "classes.view" });
  return inTenant(deps, ctx, async (tx) => {
    const t = await tx.classTemplate.findUnique({ where: { id: templateId } });
    if (!t) throw new AppError("NOT_FOUND", "Class not found.");
    requirePermission(ctx, "classes.view", { branchId: t.branchId });
    return {
      ...t,
      startTime: formatClock(t.startMinute),
      startDate: fromDbDate(t.startDate),
      untilDate: t.untilDate ? fromDbDate(t.untilDate) : null,
      rrule: rruleOf(t),
    };
  });
}

// --- materialization ------------------------------------------------------------------------

async function branchTimezone(
  tx: TenantTransaction,
  tenantId: string,
  branchId: string,
): Promise<string> {
  const [branch, tenant] = await inOrder([
    tx.branch.findUniqueOrThrow({ where: { id: branchId } }),
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  ]);
  return branch.timezone ?? tenant.timezone;
}

/** Busy intervals (classes and PT) of a trainer or room around a time range. */
async function busyAround(
  tx: TenantTransaction,
  filter: { trainerIds: string[]; roomIds: string[] },
  from: Date,
  to: Date,
): Promise<Busy[]> {
  if (filter.trainerIds.length === 0 && filter.roomIds.length === 0) return [];
  const [sessions, appointments] = await inOrder([
    tx.classSession.findMany({
      where: {
        status: "SCHEDULED",
        startsAt: { lt: to },
        endsAt: { gt: from },
        OR: [
          ...(filter.trainerIds.length
            ? [{ trainerId: { in: filter.trainerIds } }]
            : []),
          ...(filter.roomIds.length
            ? [{ roomId: { in: filter.roomIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        name: true,
        startsAt: true,
        endsAt: true,
        trainerId: true,
        roomId: true,
      },
    }),
    filter.trainerIds.length
      ? tx.ptAppointment.findMany({
          where: {
            status: "SCHEDULED",
            trainerId: { in: filter.trainerIds },
            startsAt: { lt: to },
            endsAt: { gt: from },
          },
          select: { id: true, startsAt: true, endsAt: true, trainerId: true },
        })
      : Promise.resolve([]),
  ]);
  return [
    ...sessions.map((s) => ({
      id: s.id,
      kind: "CLASS" as const,
      label: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      trainerId: s.trainerId,
      roomId: s.roomId,
    })),
    ...appointments.map((a) => ({
      id: a.id,
      kind: "PT" as const,
      label: "a PT session",
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      trainerId: a.trainerId,
      roomId: null,
    })),
  ];
}

async function trainerAvailabilityRows(
  tx: TenantTransaction,
  trainerId: string,
): Promise<AvailabilityRow[]> {
  const trainer = await tx.trainerProfile.findUnique({
    where: { id: trainerId },
    select: { userId: true },
  });
  if (!trainer) return [];
  const rows = await tx.staffAvailability.findMany({
    where: { userId: trainer.userId },
  });
  return rows.map((r) => ({
    kind: r.kind,
    dayOfWeek: r.dayOfWeek,
    date: r.date ? fromDbDate(r.date) : null,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    available: r.available,
    branchId: r.branchId,
  }));
}

/** Conflicts for one candidate session or appointment. */
export async function conflictsFor(
  tx: TenantTransaction,
  candidate: {
    id?: string;
    startsAt: Date;
    endsAt: Date;
    trainerId: string | null;
    roomId: string | null;
    branchId: string;
    timezone: string;
  },
): Promise<Conflict[]> {
  const busy = await busyAround(
    tx,
    {
      trainerIds: candidate.trainerId ? [candidate.trainerId] : [],
      roomIds: candidate.roomId ? [candidate.roomId] : [],
    },
    candidate.startsAt,
    candidate.endsAt,
  );
  let availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" = "UNKNOWN";
  if (candidate.trainerId) {
    const rows = await trainerAvailabilityRows(tx, candidate.trainerId);
    const date = todayIn(candidate.timezone, candidate.startsAt);
    const start = localMinuteOf(candidate.startsAt, candidate.timezone);
    const minutes = Math.round(
      (candidate.endsAt.getTime() - candidate.startsAt.getTime()) / 60_000,
    );
    availability = availabilityFor(
      rows,
      date,
      start,
      Math.min(start + minutes, 1440),
      candidate.branchId,
    );
  }
  return findConflicts(candidate, busy, availability);
}

export type MaterializeResult = {
  created: number;
  updated: number;
  removed: number;
  /** Sessions left unchanged because they already have bookings. */
  flagged: number;
  conflicts: { date: LocalDate; messages: string[] }[];
};

/**
 * Builds the template's sessions from `today` for MATERIALIZE_DAYS, idempotently:
 * - missing occurrences are created;
 * - sessions from an older template version are updated, unless they have bookings or a
 *   waitlist — those keep their details and get a conflict note for staff to resolve;
 * - future sessions no longer in the schedule (or of an archived template) are removed, again
 *   unless they have bookings (flagged instead).
 */
export async function materializeTemplate(
  tx: TenantTransaction,
  tenantId: string,
  templateId: string,
  today: LocalDate,
  now: Date = new Date(),
): Promise<MaterializeResult> {
  const t = await tx.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
  });
  const tz = await branchTimezone(tx, tenantId, t.branchId);
  const horizon = addDays(today, MATERIALIZE_DAYS);
  const wanted =
    t.status === "ACTIVE"
      ? occurrencesBetween(
          {
            byDays: t.byDays,
            startDate: fromDbDate(t.startDate),
            untilDate: t.untilDate ? fromDbDate(t.untilDate) : null,
            count: t.occurrenceCount,
          },
          today,
          horizon,
        )
      : [];
  const existing = await tx.classSession.findMany({
    where: {
      templateId: t.id,
      occurrenceDate: { gte: toDbDate(today) },
      status: "SCHEDULED",
    },
    include: {
      _count: { select: { waitlist: { where: { status: "WAITING" } } } },
    },
  });
  const byDate = new Map(
    existing.map((s) => [fromDbDate(s.occurrenceDate!), s]),
  );
  const wantedSet = new Set(wanted);
  const result: MaterializeResult = {
    created: 0,
    updated: 0,
    removed: 0,
    flagged: 0,
    conflicts: [],
  };
  const fields = (date: LocalDate) => {
    const startsAt = localTimeToUtc(date, t.startMinute, tz);
    return {
      name: t.name,
      categoryId: t.categoryId,
      trainerId: t.trainerId,
      roomId: t.roomId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + t.durationMinutes * 60_000),
      capacity: t.capacity,
      eligiblePlanCodes: t.eligiblePlanCodes,
      bookingOpensHours: t.bookingOpensHours,
      bookingClosesMinutes: t.bookingClosesMinutes,
      cancelCutoffMinutes: t.cancelCutoffMinutes,
      waitlistEnabled: t.waitlistEnabled,
      waitlistMax: t.waitlistMax,
      templateVersion: t.version,
    };
  };
  for (const date of wanted) {
    const data = fields(date);
    if (data.startsAt.getTime() <= now.getTime()) continue; // never create past sessions
    const session = byDate.get(date);
    if (!session) {
      const conflicts = await conflictsFor(tx, {
        ...data,
        branchId: t.branchId,
        timezone: tz,
      });
      await tx.classSession.create({
        data: {
          tenantId,
          branchId: t.branchId,
          templateId: t.id,
          occurrenceDate: toDbDate(date),
          ...data,
          conflictNote: conflicts.length
            ? conflicts.map((c) => c.message).join(" ")
            : null,
        },
      });
      if (conflicts.length)
        result.conflicts.push({
          date,
          messages: conflicts.map((c) => c.message),
        });
      result.created++;
    } else if ((session.templateVersion ?? 0) < t.version) {
      const hasPeople = session.bookedCount > 0 || session._count.waitlist > 0;
      if (hasPeople) {
        await tx.classSession.update({
          where: { id: session.id },
          data: {
            conflictNote:
              "The class schedule changed, but this session already has bookings, so it kept its old details. Edit or cancel it here.",
          },
        });
        result.flagged++;
      } else {
        const conflicts = await conflictsFor(tx, {
          id: session.id,
          ...data,
          branchId: t.branchId,
          timezone: tz,
        });
        await tx.classSession.update({
          where: { id: session.id },
          data: {
            ...data,
            conflictNote: conflicts.length
              ? conflicts.map((c) => c.message).join(" ")
              : null,
          },
        });
        if (conflicts.length)
          result.conflicts.push({
            date,
            messages: conflicts.map((c) => c.message),
          });
        result.updated++;
      }
    }
  }
  for (const [date, session] of byDate) {
    if (wantedSet.has(date)) continue;
    if (session.startsAt.getTime() <= now.getTime()) continue;
    if (session.bookedCount > 0 || session._count.waitlist > 0) {
      await tx.classSession.update({
        where: { id: session.id },
        data: {
          conflictNote:
            "This date is no longer in the class schedule, but it has bookings. Cancel it here to tell the members.",
        },
      });
      result.flagged++;
    } else {
      await tx.classSession.delete({ where: { id: session.id } });
      result.removed++;
    }
  }
  return result;
}

/** Worker: extends every active template's sessions to the 8-week horizon. */
export async function materializeAllTemplates(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
  now: Date = new Date(),
) {
  const templates = await tx.classTemplate.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  let created = 0;
  for (const t of templates) {
    created += (await materializeTemplate(tx, tenantId, t.id, today, now))
      .created;
  }
  return { templates: templates.length, created };
}

// --- one-off sessions and edits -------------------------------------------------------------

const sessionSchema = z.object({
  branchId: z.uuid("Pick a branch."),
  name: z.string().trim().min(2, "Give the class a name.").max(80),
  categoryId: optionalUuid,
  trainerId: optionalUuid,
  roomId: optionalUuid,
  date: z.string().refine(isLocalDate, "Pick a date."),
  startTime: clock,
  durationMinutes: z.coerce.number().int().min(10).max(480),
  capacity: z.coerce.number().int().positive().max(500),
  eligiblePlanCodes: z.preprocess(
    (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
    z.array(z.string().trim().min(1).max(40)).max(50),
  ),
  bookingOpensHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(168),
  bookingClosesMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),
  cancelCutoffMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60)
    .default(120),
  waitlistEnabled: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
  ignoreConflicts: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
});

/** A single class (not from a template). Conflicts block unless confirmed. */
export async function createClassSession(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(sessionSchema, raw);
  await guard(deps, ctx, {
    permission: "classes.manage",
    branchId: input.branchId,
    write: true,
    entitlement: CLASSES,
  });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    await checkTemplateRefs(tx, {
      ...input,
      byDays: [1],
      startDate: input.date,
      occurrenceCount: null,
      waitlistMax: null,
    });
    const tz = await branchTimezone(tx, ctx.tenantId, input.branchId);
    const startsAt = localTimeToUtc(
      input.date,
      parseClock(input.startTime),
      tz,
    );
    if (startsAt.getTime() <= now.getTime())
      throw new AppError("VALIDATION_FAILED", "Pick a time in the future.", {
        fields: { startTime: ["In the past."] },
      });
    const endsAt = new Date(
      startsAt.getTime() + input.durationMinutes * 60_000,
    );
    const conflicts = await conflictsFor(tx, {
      startsAt,
      endsAt,
      trainerId: input.trainerId,
      roomId: input.roomId,
      branchId: input.branchId,
      timezone: tz,
    });
    if (conflicts.length && !input.ignoreConflicts)
      throw new AppError(
        "CONFLICT",
        conflicts.map((c) => c.message).join(" "),
        {
          details: { conflicts },
        },
      );
    const session = await tx.classSession.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        name: input.name,
        categoryId: input.categoryId,
        trainerId: input.trainerId,
        roomId: input.roomId,
        startsAt,
        endsAt,
        capacity: input.capacity,
        eligiblePlanCodes: input.eligiblePlanCodes,
        bookingOpensHours: input.bookingOpensHours,
        bookingClosesMinutes: input.bookingClosesMinutes,
        cancelCutoffMinutes: input.cancelCutoffMinutes,
        waitlistEnabled: input.waitlistEnabled,
        conflictNote: conflicts.length
          ? conflicts.map((c) => c.message).join(" ")
          : null,
      },
    });
    await recordAudit(tx, ctx, {
      action: "class_session.created",
      entityType: "ClassSession",
      entityId: session.id,
      branchId: session.branchId,
      after: { name: session.name, startsAt, capacity: session.capacity },
      meta: conflicts.length ? { conflictsAccepted: conflicts } : undefined,
    });
    return session;
  });
}

const editSessionSchema = z.object({
  trainerId: optionalUuid,
  roomId: optionalUuid,
  capacity: z.coerce.number().int().positive().max(500),
  ignoreConflicts: z
    .union([z.boolean(), z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on"),
});

/** Change one session's trainer, room or capacity (not below the people already booked). */
export async function updateClassSession(
  deps: CoreDeps,
  ctx: AuthContext,
  sessionId: string,
  raw: unknown,
) {
  const input = parseInput(editSessionSchema, raw);
  await guard(deps, ctx, { permission: "classes.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM app.class_session WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const session = await tx.classSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new AppError("NOT_FOUND", "Class not found.");
    requirePermission(ctx, "classes.manage", { branchId: session.branchId });
    if (session.status !== "SCHEDULED")
      throw new AppError("CONFLICT", "Only scheduled classes can be changed.");
    if (input.capacity < session.bookedCount)
      throw new AppError(
        "VALIDATION_FAILED",
        `${session.bookedCount} people are booked; capacity can't go below that.`,
        { fields: { capacity: [`At least ${session.bookedCount}.`] } },
      );
    const tz = await branchTimezone(tx, ctx.tenantId, session.branchId);
    const conflicts = await conflictsFor(tx, {
      id: session.id,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      trainerId: input.trainerId,
      roomId: input.roomId,
      branchId: session.branchId,
      timezone: tz,
    });
    if (conflicts.length && !input.ignoreConflicts)
      throw new AppError(
        "CONFLICT",
        conflicts.map((c) => c.message).join(" "),
        {
          details: { conflicts },
        },
      );
    const updated = await tx.classSession.update({
      where: { id: session.id },
      data: {
        trainerId: input.trainerId,
        roomId: input.roomId,
        capacity: input.capacity,
        conflictNote: conflicts.length
          ? conflicts.map((c) => c.message).join(" ")
          : null,
      },
    });
    await recordAudit(tx, ctx, {
      action: "class_session.updated",
      entityType: "ClassSession",
      entityId: session.id,
      branchId: session.branchId,
      before: {
        trainerId: session.trainerId,
        roomId: session.roomId,
        capacity: session.capacity,
      },
      after: input,
    });
    return updated;
  });
}

const cancelSessionSchema = z.object({
  reason: z.string().trim().min(3, "Tell members why.").max(300),
});

/**
 * Cancels a class: every booking is cancelled with its credit returned, the waitlist is closed,
 * and members are told (in-app + email).
 */
export async function cancelClassSession(
  deps: CoreDeps,
  ctx: AuthContext,
  sessionId: string,
  raw: unknown,
) {
  const { reason } = parseInput(cancelSessionSchema, raw);
  await guard(deps, ctx, { permission: "classes.manage", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM app.class_session WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const session = await tx.classSession.findUnique({
      where: { id: sessionId },
      include: { branch: true },
    });
    if (!session) throw new AppError("NOT_FOUND", "Class not found.");
    requirePermission(ctx, "classes.manage", { branchId: session.branchId });
    if (session.status !== "SCHEDULED")
      throw new AppError("CONFLICT", "This class isn't scheduled.");
    const bookings = await tx.booking.findMany({
      where: { sessionId, status: "BOOKED" },
      include: { member: true },
    });
    for (const b of bookings) {
      await tx.booking.update({
        where: { id: b.id },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledById: ctx.userId,
          cancelReason: `Class cancelled: ${reason}`,
        },
      });
      if (b.usedCredit && b.membershipId)
        await tx.entitlementLedger.createMany({
          data: [
            {
              tenantId: ctx.tenantId,
              memberId: b.memberId,
              kind: "CLASS_CREDIT",
              membershipId: b.membershipId,
              delta: 1,
              reason: "BOOKING_RETURNED",
              bookingId: b.id,
              note: "Class cancelled",
              createdById: ctx.userId,
            },
          ],
          skipDuplicates: true,
        });
    }
    await tx.waitlistEntry.updateMany({
      where: { sessionId, status: "WAITING" },
      data: { status: "EXPIRED", note: "Class cancelled" },
    });
    await tx.classSession.update({
      where: { id: sessionId },
      data: {
        status: "CANCELLED",
        bookedCount: 0,
        cancelledAt: now,
        cancelledById: ctx.userId,
        cancelReason: reason,
      },
    });
    const tz = session.branch.timezone ?? ctx.timezone;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    for (const b of bookings) {
      await notify(tx, ctx.tenantId, {
        templateKey: "class.cancelled",
        recipient: {
          memberId: b.memberId,
          userId: b.member.userId,
          email: b.member.email,
        },
        data: {
          name: b.member.firstName,
          gym: tenant.displayName,
          class: session.name,
          date: todayIn(tz, session.startsAt),
          time: formatClock(localMinuteOf(session.startsAt, tz)),
          reason,
        },
        link: "/m/classes",
        dedupeKey: `class-cancelled:${b.id}`,
      });
    }
    await recordAudit(tx, ctx, {
      action: "class_session.cancelled",
      entityType: "ClassSession",
      entityId: sessionId,
      branchId: session.branchId,
      meta: { reason, bookingsCancelled: bookings.length },
    });
    return { bookingsCancelled: bookings.length };
  });
}

// --- calendar -------------------------------------------------------------------------------

const calendarSchema = z.object({
  from: z.string().refine(isLocalDate).optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
  branchId: z.uuid().optional(),
  trainerId: z.uuid().optional(),
});

/** Sessions for a week/day view, in the tenant timezone. */
export async function listClassSessions(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "classes.view" });
  const input = parseInput(calendarSchema, raw);
  const from = input.from ?? todayIn(ctx.timezone, nowOf(deps));
  const to = addDays(from, input.days);
  const allowed = allowedBranchIds(ctx, "classes.view");
  if (input.branchId)
    requirePermission(ctx, "classes.view", { branchId: input.branchId });
  const where: Prisma.ClassSessionWhereInput = {
    startsAt: {
      gte: startOfDayUtc(from, ctx.timezone),
      lt: startOfDayUtc(to, ctx.timezone),
    },
    ...(input.branchId
      ? { branchId: input.branchId }
      : allowed === "ALL"
        ? {}
        : { branchId: { in: allowed } }),
    ...(input.trainerId ? { trainerId: input.trainerId } : {}),
  };
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.classSession.findMany({
      where,
      orderBy: { startsAt: "asc" },
      include: {
        category: { select: { name: true, color: true } },
        trainer: { select: { displayName: true } },
        room: { select: { name: true } },
        branch: { select: { name: true, timezone: true } },
        _count: { select: { waitlist: { where: { status: "WAITING" } } } },
      },
    });
    return {
      from,
      to,
      days: input.days,
      sessions: rows.map((s) => {
        const tz = s.branch.timezone ?? ctx.timezone;
        return {
          id: s.id,
          name: s.name,
          date: todayIn(tz, s.startsAt),
          startTime: formatClock(localMinuteOf(s.startsAt, tz)),
          endTime: formatClock(localMinuteOf(s.endsAt, tz)),
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          status: s.status,
          capacity: s.capacity,
          bookedCount: s.bookedCount,
          waitlist: s._count.waitlist,
          category: s.category,
          trainer: s.trainer?.displayName ?? null,
          room: s.room?.name ?? null,
          branch: s.branch.name,
          conflictNote: s.conflictNote,
        };
      }),
    };
  });
}

/** Session detail with roster and waitlist (classes.view at the branch). */
export async function getClassSession(
  deps: CoreDeps,
  ctx: AuthContext,
  sessionId: string,
) {
  await guard(deps, ctx, { permission: "dashboard.view" });
  return inTenant(deps, ctx, async (tx) => {
    const s = await tx.classSession.findUnique({
      where: { id: sessionId },
      include: {
        category: true,
        trainer: true,
        room: true,
        branch: true,
        bookings: {
          orderBy: { createdAt: "asc" },
          include: {
            member: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                memberCode: true,
              },
            },
          },
        },
        waitlist: {
          orderBy: { position: "asc" },
          include: {
            member: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                memberCode: true,
              },
            },
          },
        },
      },
    });
    if (!s) throw new AppError("NOT_FOUND", "Class not found.");
    // The class's own trainer may open it from any branch (trainer "my day").
    const ownClass = s.trainer?.userId === ctx.userId;
    if (!ownClass)
      requirePermission(ctx, "classes.view", { branchId: s.branchId });
    const tz = s.branch.timezone ?? ctx.timezone;
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      branchId: s.branchId,
      branch: s.branch.name,
      templateId: s.templateId,
      date: todayIn(tz, s.startsAt),
      startTime: formatClock(localMinuteOf(s.startsAt, tz)),
      endTime: formatClock(localMinuteOf(s.endsAt, tz)),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      bookedCount: s.bookedCount,
      category: s.category
        ? { name: s.category.name, color: s.category.color }
        : null,
      trainer: s.trainer
        ? { id: s.trainer.id, name: s.trainer.displayName }
        : null,
      room: s.room ? { id: s.room.id, name: s.room.name } : null,
      eligiblePlanCodes: s.eligiblePlanCodes,
      cancelCutoffAt: cancelCutoffAt(s),
      waitlistEnabled: s.waitlistEnabled,
      conflictNote: s.conflictNote,
      cancelReason: s.cancelReason,
      bookings: s.bookings.map((b) => ({
        id: b.id,
        status: b.status,
        source: b.source,
        lateCancel: b.lateCancel,
        usedCredit: b.usedCredit,
        member: { ...b.member, name: memberName(b.member) },
        createdAt: b.createdAt,
      })),
      waitlist: s.waitlist.map((w) => ({
        id: w.id,
        position: w.position,
        status: w.status,
        note: w.note,
        member: { ...w.member, name: memberName(w.member) },
      })),
      canManage: hasPermission(ctx, "classes.manage", { branchId: s.branchId }),
      canBook: hasPermission(ctx, "bookings.manage", { branchId: s.branchId }),
      canMark:
        hasPermission(ctx, "classes.attendance", { branchId: s.branchId }) ||
        (ownClass && hasPermission(ctx, "classes.attendance")),
    };
  });
}

export type { AuditActor };
