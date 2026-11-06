import { z } from "zod";
import { recordAudit } from "../audit";
import { type AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import {
  formatClock,
  fromDbDate,
  isLocalDate,
  parseClock,
  toDbDate,
} from "../time/dates";
import { parseInput } from "../validation";
import { loadStaffMember } from "./profiles";

/**
 * Working hours. Staff edit their own; staff.manage edits anyone they can see. Times are local
 * wall-clock times at the branch.
 */
async function checkAccess(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
  write: boolean,
) {
  if (userId === ctx.userId) {
    await guard(deps, ctx, { permission: "dashboard.view", write });
    return;
  }
  await guard(deps, ctx, {
    permission: write ? "staff.manage" : "staff.view",
    write,
  });
  await inTenant(deps, ctx, (tx) =>
    loadStaffMember(tx, ctx, userId, write ? "staff.manage" : "staff.view"),
  );
}

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM.");

const slotSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    from: clock,
    to: clock,
    branchId: z.preprocess(
      (v) => (v === "" || v === undefined ? null : v),
      z.uuid().nullable(),
    ),
  })
  .refine((s) => parseClock(s.from) < parseClock(s.to), {
    message: "The end time must be after the start time.",
    path: ["to"],
  });

const weeklySchema = z.object({ slots: z.array(slotSchema).max(50) });

/** Replaces the weekly hours in one go (the form shows the whole week). */
export async function setWeeklyAvailability(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
  raw: unknown,
) {
  await checkAccess(deps, ctx, userId, true);
  const { slots } = parseInput(weeklySchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    await tx.staffAvailability.deleteMany({
      where: { userId, kind: "WEEKLY" },
    });
    if (slots.length)
      await tx.staffAvailability.createMany({
        data: slots.map((s) => ({
          tenantId: ctx.tenantId,
          userId,
          branchId: s.branchId,
          kind: "WEEKLY" as const,
          dayOfWeek: s.dayOfWeek,
          startMinute: parseClock(s.from),
          endMinute: parseClock(s.to),
        })),
      });
    await recordAudit(tx, ctx, {
      action: "staff.availability_set",
      entityType: "StaffAvailability",
      entityId: userId,
      after: { slots },
    });
    return { slots: slots.length };
  });
}

const exceptionSchema = z
  .object({
    date: z.string().refine(isLocalDate, "Pick a date."),
    available: z
      .union([z.boolean(), z.literal("true"), z.literal("false")])
      .transform((v) => v === true || v === "true"),
    from: clock.default("00:00"),
    to: clock.default("24:00"),
    note: z.string().trim().max(200).optional(),
  })
  .refine((s) => parseClock(s.from) < parseClock(s.to), {
    message: "The end time must be after the start time.",
    path: ["to"],
  });

/** Leave (not available) or extra hours on a date. */
export async function addAvailabilityException(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
  raw: unknown,
) {
  await checkAccess(deps, ctx, userId, true);
  const input = parseInput(exceptionSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.staffAvailability.create({
      data: {
        tenantId: ctx.tenantId,
        userId,
        kind: "EXCEPTION",
        date: toDbDate(input.date),
        startMinute: parseClock(input.from),
        endMinute: parseClock(input.to),
        available: input.available,
        note: input.note || null,
      },
    });
    await recordAudit(tx, ctx, {
      action: "staff.availability_exception_added",
      entityType: "StaffAvailability",
      entityId: row.id,
      after: input,
    });
    return row;
  });
}

export async function removeAvailabilityException(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
) {
  const row = await inTenant(deps, ctx, (tx) =>
    tx.staffAvailability.findUnique({ where: { id } }),
  );
  if (!row || row.kind !== "EXCEPTION")
    throw new AppError("NOT_FOUND", "Not found.");
  await checkAccess(deps, ctx, row.userId, true);
  return inTenant(deps, ctx, async (tx) => {
    await tx.staffAvailability.delete({ where: { id } });
    await recordAudit(tx, ctx, {
      action: "staff.availability_exception_removed",
      entityType: "StaffAvailability",
      entityId: id,
    });
  });
}

export async function getAvailability(
  deps: CoreDeps,
  ctx: AuthContext,
  userId: string,
) {
  await checkAccess(deps, ctx, userId, false);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.staffAvailability.findMany({
      where: { userId },
      orderBy: [
        { kind: "asc" },
        { dayOfWeek: "asc" },
        { date: "asc" },
        { startMinute: "asc" },
      ],
    });
    return {
      weekly: rows
        .filter((r) => r.kind === "WEEKLY")
        .map((r) => ({
          id: r.id,
          dayOfWeek: r.dayOfWeek!,
          from: formatClock(r.startMinute),
          to: formatClock(r.endMinute),
          branchId: r.branchId,
        })),
      exceptions: rows
        .filter((r) => r.kind === "EXCEPTION")
        .map((r) => ({
          id: r.id,
          date: fromDbDate(r.date!),
          from: formatClock(r.startMinute),
          to: formatClock(r.endMinute),
          available: r.available,
          note: r.note,
        })),
    };
  });
}
