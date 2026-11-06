import { inOrder, withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit, type AuditActor } from "../audit";
import { hasPermission, requirePermission, type AuthContext } from "../authz";
import {
  invoiceBalances,
  issueInvoiceTx,
  num,
  PAYMENT_METHODS,
  recordPaymentSchema,
  recordPaymentTx,
} from "../billing/service";
import { conflictsFor } from "../classes/service";
import { ptSessionBalance } from "../credits/ledger";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { memberName } from "../members/service";
import { minorToMajorString, parseMajorToMinor } from "../money";
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
import { canViewClient, isMyClient, trainerOf } from "./assignments";
import { activatePaidPtBalances } from "./pt-activation";

export { activatePaidPtBalances };

const PT = "pt.enabled" as const;

// --- catalogue ------------------------------------------------------------------------------

const packageSchema = z.object({
  name: z.string().trim().min(2, "Name the package.").max(80),
  description: z.string().trim().max(500).optional(),
  sessionCount: z.coerce.number().int().min(1, "At least 1 session.").max(500),
  validityDays: z.coerce.number().int().min(1).max(3650),
  sessionMinutes: z.coerce.number().int().min(15).max(240).default(60),
  price: z.string().trim().min(1, "Enter a price."),
  taxRateBps: z.coerce.number().int().min(0).max(2800).default(1800),
  sacCode: z.string().trim().max(10).default("999723"),
});

function priceMinor(price: string) {
  const minor = parseMajorToMinor(price);
  if (minor === null || minor < 0)
    throw new AppError("VALIDATION_FAILED", "Enter a price.", {
      fields: { price: ["Enter a price, e.g. 6000."] },
    });
  return BigInt(minor);
}

function codeFor(name: string) {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "PT"
  );
}

export async function createPtPackage(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "plans.manage",
    write: true,
    entitlement: PT,
  });
  const input = parseInput(packageSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    let code = codeFor(input.name);
    for (let i = 2; await tx.ptPackage.findFirst({ where: { code } }); i++)
      code = `${codeFor(input.name).slice(0, 20)}-${i}`;
    const pkg = await tx.ptPackage.create({
      data: {
        tenantId: ctx.tenantId,
        code,
        name: input.name,
        description: input.description || null,
        sessionCount: input.sessionCount,
        validityDays: input.validityDays,
        sessionMinutes: input.sessionMinutes,
        priceMinor: priceMinor(input.price),
        taxRateBps: input.taxRateBps,
        sacCode: input.sacCode,
      },
    });
    await recordAudit(tx, ctx, {
      action: "pt_package.created",
      entityType: "PtPackage",
      entityId: pkg.id,
      after: { ...input },
    });
    return pkg;
  });
}

/** Edits apply to future sales; sold packages keep their own copy of the terms. */
export async function updatePtPackage(
  deps: CoreDeps,
  ctx: AuthContext,
  packageId: string,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "plans.manage",
    write: true,
    entitlement: PT,
  });
  const input = parseInput(packageSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const existing = await tx.ptPackage.findUnique({
      where: { id: packageId },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Package not found.");
    const pkg = await tx.ptPackage.update({
      where: { id: packageId },
      data: {
        name: input.name,
        description: input.description || null,
        sessionCount: input.sessionCount,
        validityDays: input.validityDays,
        sessionMinutes: input.sessionMinutes,
        priceMinor: priceMinor(input.price),
        taxRateBps: input.taxRateBps,
        sacCode: input.sacCode,
      },
    });
    await recordAudit(tx, ctx, {
      action: "pt_package.updated",
      entityType: "PtPackage",
      entityId: pkg.id,
      before: {
        name: existing.name,
        sessionCount: existing.sessionCount,
        priceMinor: existing.priceMinor,
      },
      after: { ...input },
    });
    return pkg;
  });
}

export async function setPtPackageArchived(
  deps: CoreDeps,
  ctx: AuthContext,
  packageId: string,
  archived: boolean,
) {
  await guard(deps, ctx, { permission: "plans.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const pkg = await tx.ptPackage.update({
      where: { id: packageId },
      data: { status: archived ? "ARCHIVED" : "ACTIVE" },
    });
    await recordAudit(tx, ctx, {
      action: archived ? "pt_package.archived" : "pt_package.restored",
      entityType: "PtPackage",
      entityId: pkg.id,
    });
    return pkg;
  });
}

export async function listPtPackages(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { includeArchived?: boolean } = {},
) {
  await guard(deps, ctx, { permission: "memberships.view" });
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.ptPackage.findMany({
      where: options.includeArchived ? {} : { status: "ACTIVE" },
      orderBy: { name: "asc" },
    });
    return rows.map((p) => ({
      ...p,
      price: minorToMajorString(num(p.priceMinor)),
      priceMinor: num(p.priceMinor),
    }));
  });
}

export async function getPtPackage(
  deps: CoreDeps,
  ctx: AuthContext,
  packageId: string,
) {
  await guard(deps, ctx, { permission: "memberships.view" });
  return inTenant(deps, ctx, async (tx) => {
    const p = await tx.ptPackage.findUnique({ where: { id: packageId } });
    if (!p) throw new AppError("NOT_FOUND", "Package not found.");
    return { ...p, price: minorToMajorString(num(p.priceMinor)) };
  });
}

// --- sale and activation --------------------------------------------------------------------

const saleSchema = z.object({
  memberId: z.uuid(),
  packageId: z.uuid("Pick a package."),
  branchId: z.uuid().optional(),
  trainerId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
  payment: z
    .object({
      method: z.enum(PAYMENT_METHODS),
      amountMinor: z.coerce.number().int().positive(),
      reference: z.string().trim().max(100).optional(),
    })
    .optional(),
});

/**
 * Sells a PT package like a plan: a balance (PENDING_PAYMENT) + an invoice line (SAC/tax from the
 * package) + optional payment now, activated per the tenant's activation policy — one transaction.
 */
export async function sellPtPackage(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "memberships.sell",
    write: true,
    entitlement: PT,
  });
  const input = parseInput(saleSchema, raw);
  if (input.payment) requirePermission(ctx, "billing.collect");
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    const member = await tx.memberProfile.findUnique({
      where: { id: input.memberId },
    });
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    if (member.status !== "ACTIVE")
      throw new AppError("CONFLICT", "Only active members can buy a package.");
    const branchId =
      input.branchId ?? ctx.activeBranchId ?? member.homeBranchId;
    requirePermission(ctx, "memberships.sell", { branchId });
    const pkg = await tx.ptPackage.findUnique({
      where: { id: input.packageId },
    });
    if (!pkg || pkg.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick an active package.", {
        fields: { packageId: ["Pick an active package."] },
      });
    if (input.trainerId) {
      const trainer = await tx.trainerProfile.findUnique({
        where: { id: input.trainerId },
      });
      if (!trainer || trainer.status !== "ACTIVE")
        throw new AppError("VALIDATION_FAILED", "Pick an active trainer.", {
          fields: { trainerId: ["Pick an active trainer."] },
        });
    }
    const balance = await tx.ptPackageBalance.create({
      data: {
        tenantId: ctx.tenantId,
        memberId: member.id,
        packageId: pkg.id,
        branchId,
        trainerId: input.trainerId ?? null,
        name: pkg.name,
        sessionsTotal: pkg.sessionCount,
        sessionMinutes: pkg.sessionMinutes,
        validityDays: pkg.validityDays,
        createdById: ctx.userId,
      },
    });
    const invoice = await issueInvoiceTx(tx, ctx, ctx.tenantId, {
      branchId,
      memberId: member.id,
      lines: [
        {
          kind: "PT_PACKAGE",
          description: `${pkg.name}: ${pkg.sessionCount} personal training session${pkg.sessionCount === 1 ? "" : "s"}, valid ${pkg.validityDays} days from activation`,
          sacCode: pkg.sacCode,
          unitPriceMinor: num(pkg.priceMinor),
          rateBps: pkg.taxRateBps,
        },
      ],
      issueDate: today,
    });
    await tx.ptPackageBalance.update({
      where: { id: balance.id },
      data: { invoiceId: invoice.id },
    });
    // IMMEDIATE policy, a free package, or credit already covering it.
    await activatePaidPtBalances(tx, ctx, ctx.tenantId, [invoice.id], now);
    let payment = null;
    if (input.payment) {
      const outstanding = (await invoiceBalances(tx, [invoice.id])).get(
        invoice.id,
      )!.outstandingMinor;
      const parsed = recordPaymentSchema.parse({
        memberId: member.id,
        branchId,
        method: input.payment.method,
        amountMinor: input.payment.amountMinor,
        reference: input.payment.reference,
        allocations: outstanding
          ? [
              {
                invoiceId: invoice.id,
                amountMinor: Math.min(input.payment.amountMinor, outstanding),
              },
            ]
          : [],
      });
      payment = await recordPaymentTx(tx, ctx, parsed, now);
    }
    await recordAudit(tx, ctx, {
      action: "pt_package.sold",
      entityType: "PtPackageBalance",
      entityId: balance.id,
      branchId,
      after: {
        package: pkg.name,
        sessions: pkg.sessionCount,
        invoice: invoice.number,
      },
    });
    const fresh = await tx.ptPackageBalance.findUniqueOrThrow({
      where: { id: balance.id },
    });
    return { balance: fresh, invoice, payment: payment?.payment ?? null };
  });
}

async function balanceSummary(tx: TenantTransaction, balanceId: string) {
  const [left, scheduled] = await inOrder([
    ptSessionBalance(tx, balanceId),
    tx.ptAppointment.count({ where: { balanceId, status: "SCHEDULED" } }),
  ]);
  return { left, scheduled, bookable: Math.max(left - scheduled, 0) };
}

/** A member's PT packages (staff: memberships.view, or the assigned trainer). */
export async function memberPtBalances(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "dashboard.view" });
  return inTenant(deps, ctx, async (tx) => {
    const member = await tx.memberProfile.findUnique({
      where: { id: memberId },
    });
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    const allowed =
      hasPermission(ctx, "memberships.view", {
        branchId: member.homeBranchId,
      }) || (await canViewClient(tx, ctx, member.id, member.homeBranchId));
    if (!allowed)
      throw new AppError(
        "FORBIDDEN",
        "You don't have permission to see this member.",
      );
    const rows = await tx.ptPackageBalance.findMany({
      where: { memberId },
      orderBy: { createdAt: "desc" },
      include: {
        trainer: { select: { id: true, displayName: true } },
        invoice: { select: { id: true, number: true } },
      },
    });
    const out = [];
    for (const b of rows) {
      out.push({
        id: b.id,
        name: b.name,
        status: b.status,
        sessionsTotal: b.sessionsTotal,
        sessionMinutes: b.sessionMinutes,
        expiresOn: b.expiresOn ? fromDbDate(b.expiresOn) : null,
        trainer: b.trainer,
        // Trainers don't see invoices (spec §6).
        invoice: hasPermission(ctx, "billing.view", { branchId: b.branchId })
          ? b.invoice
          : null,
        ...(await balanceSummary(tx, b.id)),
      });
    }
    return out;
  });
}

// --- appointments ---------------------------------------------------------------------------

const bookSchema = z.object({
  balanceId: z.uuid("Pick a package."),
  trainerId: z.uuid("Pick a trainer."),
  date: z.string().refine(isLocalDate, "Pick a date."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM."),
  branchId: z.uuid().optional(),
  notes: z.string().trim().max(500).optional(),
});

/** pt.manage: any trainer's sessions. pt.own: only one's own, with one's own clients. */
async function checkPtAccess(
  tx: TenantTransaction,
  ctx: AuthContext,
  trainerId: string,
  memberId: string,
  branchId: string,
) {
  if (hasPermission(ctx, "pt.manage", { branchId })) return;
  if (hasPermission(ctx, "pt.own")) {
    const me = await trainerOf(tx, ctx);
    if (me && me.id === trainerId) {
      const balanceTrainer = await tx.ptPackageBalance.findFirst({
        where: { memberId, trainerId: me.id },
        select: { id: true },
      });
      if (balanceTrainer || (await isMyClient(tx, ctx, memberId))) return;
    }
  }
  throw new AppError(
    "FORBIDDEN",
    "You can only manage your own PT sessions with your own clients.",
  );
}

/** Books a PT session: package active and valid that day, a session free, trainer free. */
export async function bookPtAppointment(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(bookSchema, raw);
  await guard(deps, ctx, {
    permission: "dashboard.view",
    write: true,
    entitlement: PT,
  });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    // Serialize bookings on the same package so two can't take the last session.
    await tx.$queryRaw`SELECT id FROM app.pt_package_balance WHERE id = ${input.balanceId}::uuid FOR UPDATE`;
    const balance = await tx.ptPackageBalance.findUnique({
      where: { id: input.balanceId },
      include: { member: true },
    });
    if (!balance) throw new AppError("NOT_FOUND", "Package not found.");
    const branchId = input.branchId ?? balance.branchId;
    await checkPtAccess(tx, ctx, input.trainerId, balance.memberId, branchId);
    const trainer = await tx.trainerProfile.findUnique({
      where: { id: input.trainerId },
    });
    if (!trainer || trainer.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick an active trainer.", {
        fields: { trainerId: ["Pick an active trainer."] },
      });
    if (balance.status !== "ACTIVE")
      throw new AppError(
        "CONFLICT",
        balance.status === "PENDING_PAYMENT"
          ? "This package isn't paid yet."
          : "This package isn't active.",
      );
    if (
      balance.expiresOn &&
      compareDates(input.date, fromDbDate(balance.expiresOn)) > 0
    )
      throw new AppError(
        "VALIDATION_FAILED",
        `The package expires on ${fromDbDate(balance.expiresOn)}.`,
        { fields: { date: ["After the package expires."] } },
      );
    const { bookable } = await balanceSummary(tx, balance.id);
    if (bookable < 1)
      throw new AppError(
        "CONFLICT",
        "No sessions left to book on this package (some may already be scheduled).",
      );
    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: branchId },
    });
    const tz = branch.timezone ?? ctx.timezone;
    const startsAt = localTimeToUtc(input.date, parseClock(input.time), tz);
    if (startsAt.getTime() <= now.getTime())
      throw new AppError("VALIDATION_FAILED", "Pick a time in the future.", {
        fields: { time: ["In the past."] },
      });
    const endsAt = new Date(
      startsAt.getTime() + balance.sessionMinutes * 60_000,
    );
    const conflicts = await conflictsFor(tx, {
      startsAt,
      endsAt,
      trainerId: trainer.id,
      roomId: null,
      branchId,
      timezone: tz,
    });
    if (conflicts.length)
      throw new AppError(
        "CONFLICT",
        conflicts.map((c) => c.message).join(" "),
        {
          details: { conflicts },
        },
      );
    // The member can't be in two sessions at once either.
    const clash = await tx.ptAppointment.findFirst({
      where: {
        memberId: balance.memberId,
        status: "SCHEDULED",
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    if (clash)
      throw new AppError(
        "CONFLICT",
        "The member already has a PT session then.",
      );
    const appointment = await tx.ptAppointment.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        trainerId: trainer.id,
        memberId: balance.memberId,
        balanceId: balance.id,
        startsAt,
        endsAt,
        notes: input.notes || null,
        createdById: ctx.userId,
      },
    });
    await notify(tx, ctx.tenantId, {
      templateKey: "pt.booked",
      recipient: {
        memberId: balance.memberId,
        userId: balance.member.userId,
        email: balance.member.email,
      },
      data: {
        name: balance.member.firstName,
        trainer: trainer.displayName,
        date: input.date,
        time: input.time,
        branch: branch.name,
      },
      link: "/m/pt",
      dedupeKey: `pt-booked:${appointment.id}`,
    });
    await recordAudit(tx, ctx, {
      action: "pt_appointment.booked",
      entityType: "PtAppointment",
      entityId: appointment.id,
      branchId,
      meta: {
        memberId: balance.memberId,
        trainer: trainer.displayName,
        startsAt,
      },
    });
    return appointment;
  });
}

const markSchema = z.object({
  status: z.enum(["COMPLETED", "NO_SHOW"]),
  notes: z.string().trim().max(1000).optional(),
});

/** Completed uses one session; a no-show does too when the gym's policy says so. */
export async function markPtAppointment(
  deps: CoreDeps,
  ctx: AuthContext,
  appointmentId: string,
  raw: unknown,
) {
  const input = parseInput(markSchema, raw);
  await guard(deps, ctx, { permission: "dashboard.view", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const appt = await tx.ptAppointment.findUnique({
      where: { id: appointmentId },
    });
    if (!appt) throw new AppError("NOT_FOUND", "Session not found.");
    await checkPtAccess(tx, ctx, appt.trainerId, appt.memberId, appt.branchId);
    if (appt.status !== "SCHEDULED")
      throw new AppError("CONFLICT", "This session has already been marked.");
    if (appt.startsAt.getTime() > now.getTime())
      throw new AppError("CONFLICT", "The session hasn't started yet.");
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const consumes =
      input.status === "COMPLETED" ||
      (settings?.ptNoShowConsumesSession ?? true);
    return finishAppointment(
      tx,
      ctx,
      appt,
      input.status,
      consumes,
      now,
      input.notes,
    );
  });
}

async function finishAppointment(
  tx: TenantTransaction,
  ctx: AuthContext,
  appt: {
    id: string;
    balanceId: string;
    memberId: string;
    branchId: string;
    notes: string | null;
  },
  status: "COMPLETED" | "NO_SHOW",
  consumes: boolean,
  now: Date,
  notes?: string,
) {
  const updated = await tx.ptAppointment.update({
    where: { id: appt.id },
    data: {
      status,
      markedAt: now,
      markedById: ctx.userId,
      ...(notes ? { notes } : {}),
    },
  });
  if (consumes) {
    await tx.entitlementLedger.createMany({
      data: [
        {
          tenantId: ctx.tenantId,
          memberId: appt.memberId,
          kind: "PT_SESSION",
          ptBalanceId: appt.balanceId,
          delta: -1,
          reason:
            status === "COMPLETED" ? "SESSION_COMPLETED" : "SESSION_NO_SHOW",
          appointmentId: appt.id,
          createdById: ctx.userId,
        },
      ],
      skipDuplicates: true,
    });
    const left = await ptSessionBalance(tx, appt.balanceId);
    if (left <= 0)
      await tx.ptPackageBalance.update({
        where: { id: appt.balanceId },
        data: { status: "EXHAUSTED" },
      });
  }
  await recordAudit(tx, ctx, {
    action:
      status === "COMPLETED"
        ? "pt_appointment.completed"
        : "pt_appointment.no_show",
    entityType: "PtAppointment",
    entityId: appt.id,
    branchId: appt.branchId,
    meta: { consumedSession: consumes },
  });
  return updated;
}

const cancelSchema = z.object({
  reason: z.string().trim().min(2, "Say why.").max(300),
});

/** Cancels a PT session. Inside the gym's cutoff it counts as a no-show (policy). */
export async function cancelPtAppointment(
  deps: CoreDeps,
  ctx: AuthContext,
  appointmentId: string,
  raw: unknown,
) {
  const { reason } = parseInput(cancelSchema, raw);
  await guard(deps, ctx, { permission: "dashboard.view", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const appt = await tx.ptAppointment.findUnique({
      where: { id: appointmentId },
      include: { member: true, trainer: true, branch: true },
    });
    if (!appt) throw new AppError("NOT_FOUND", "Session not found.");
    await checkPtAccess(tx, ctx, appt.trainerId, appt.memberId, appt.branchId);
    if (appt.status !== "SCHEDULED")
      throw new AppError("CONFLICT", "This session isn't scheduled.");
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const cutoffHours = settings?.ptCancelCutoffHours ?? 12;
    const late =
      appt.startsAt.getTime() - now.getTime() < cutoffHours * 3_600_000;
    let result;
    if (late) {
      result = await finishAppointment(
        tx,
        ctx,
        appt,
        "NO_SHOW",
        settings?.ptNoShowConsumesSession ?? true,
        now,
        `Late cancellation: ${reason}`,
      );
    } else {
      result = await tx.ptAppointment.update({
        where: { id: appt.id },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledById: ctx.userId,
          cancelReason: reason,
        },
      });
      await recordAudit(tx, ctx, {
        action: "pt_appointment.cancelled",
        entityType: "PtAppointment",
        entityId: appt.id,
        branchId: appt.branchId,
        meta: { reason },
      });
    }
    const tz = appt.branch.timezone ?? ctx.timezone;
    await notify(tx, ctx.tenantId, {
      templateKey: "pt.cancelled",
      recipient: {
        memberId: appt.memberId,
        userId: appt.member.userId,
        email: appt.member.email,
      },
      data: {
        name: appt.member.firstName,
        trainer: appt.trainer.displayName,
        date: todayIn(tz, appt.startsAt),
        time: formatClock(localMinuteOf(appt.startsAt, tz)),
        reason: late
          ? `${reason} (inside the ${cutoffHours}-hour cutoff, so it counts as a no-show).`
          : reason,
      },
      link: "/m/pt",
      dedupeKey: `pt-cancelled:${appt.id}`,
    });
    return { late, appointment: result };
  });
}

const listSchema = z.object({
  from: z.string().refine(isLocalDate).optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
  trainerId: z.uuid().optional(),
  mine: z.coerce.boolean().optional(),
});

/** PT sessions for a period (staff: pt.manage; trainers: their own only). */
export async function listPtAppointments(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "dashboard.view" });
  const input = parseInput(listSchema, raw);
  const from = input.from ?? todayIn(ctx.timezone, nowOf(deps));
  return inTenant(deps, ctx, async (tx) => {
    let trainerId = input.trainerId;
    if (input.mine || !hasPermission(ctx, "pt.manage")) {
      if (!hasPermission(ctx, "pt.own") && !hasPermission(ctx, "pt.manage"))
        throw new AppError(
          "FORBIDDEN",
          "You don't have permission to see PT sessions.",
        );
      const me = await trainerOf(tx, ctx);
      if (!me) return { from, appointments: [] };
      trainerId = me.id;
    }
    const rows = await tx.ptAppointment.findMany({
      where: {
        ...(trainerId ? { trainerId } : {}),
        startsAt: {
          gte: startOfDayUtc(from, ctx.timezone),
          lt: startOfDayUtc(addDays(from, input.days), ctx.timezone),
        },
      },
      orderBy: { startsAt: "asc" },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        trainer: { select: { id: true, displayName: true } },
        branch: { select: { name: true, timezone: true } },
        balance: { select: { name: true } },
      },
    });
    return {
      from,
      appointments: rows.map((a) => {
        const tz = a.branch.timezone ?? ctx.timezone;
        return {
          id: a.id,
          status: a.status,
          date: todayIn(tz, a.startsAt),
          startTime: formatClock(localMinuteOf(a.startsAt, tz)),
          endTime: formatClock(localMinuteOf(a.endsAt, tz)),
          startsAt: a.startsAt,
          member: { ...a.member, name: memberName(a.member) },
          trainer: a.trainer,
          branch: a.branch.name,
          package: a.balance.name,
          notes: a.notes,
        };
      }),
    };
  });
}

/** Trainer's "my day": today's classes and PT sessions, and the client count. */
export async function trainerDay(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "dashboard.view" });
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    const me = await trainerOf(tx, ctx);
    if (!me) return null;
    const range = {
      gte: startOfDayUtc(today, ctx.timezone),
      lt: startOfDayUtc(addDays(today, 1), ctx.timezone),
    };
    const [classes, sessions, clients] = await inOrder([
      tx.classSession.findMany({
        where: {
          trainerId: me.id,
          startsAt: range,
          status: { not: "CANCELLED" },
        },
        orderBy: { startsAt: "asc" },
        include: {
          branch: { select: { name: true, timezone: true } },
          room: true,
        },
      }),
      tx.ptAppointment.findMany({
        where: {
          trainerId: me.id,
          startsAt: range,
          status: { not: "CANCELLED" },
        },
        orderBy: { startsAt: "asc" },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          branch: { select: { timezone: true } },
        },
      }),
      tx.trainerClientAssignment.count({
        where: { trainerId: me.id, endedAt: null },
      }),
    ]);
    return {
      trainer: { id: me.id, displayName: me.displayName },
      today,
      clients,
      classes: classes.map((c) => {
        const tz = c.branch.timezone ?? ctx.timezone;
        return {
          id: c.id,
          name: c.name,
          startTime: formatClock(localMinuteOf(c.startsAt, tz)),
          endTime: formatClock(localMinuteOf(c.endsAt, tz)),
          booked: c.bookedCount,
          capacity: c.capacity,
          room: c.room?.name ?? null,
          branch: c.branch.name,
          status: c.status,
        };
      }),
      pt: sessions.map((a) => {
        const tz = a.branch.timezone ?? ctx.timezone;
        return {
          id: a.id,
          member: memberName(a.member),
          memberId: a.member.id,
          startTime: formatClock(localMinuteOf(a.startsAt, tz)),
          status: a.status,
          started: a.startsAt.getTime() <= now.getTime(),
        };
      }),
    };
  });
}

// --- member app -----------------------------------------------------------------------------

export async function listMyPt(deps: CoreDeps, mctx: MemberContext) {
  const now = nowOf(deps);
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      const balances = await tx.ptPackageBalance.findMany({
        where: {
          memberId: mctx.memberId,
          status: { in: ["ACTIVE", "PENDING_PAYMENT", "EXHAUSTED"] },
        },
        orderBy: { createdAt: "desc" },
        include: {
          trainer: { select: { displayName: true, visibleToMembers: true } },
        },
      });
      const out = [];
      for (const b of balances) {
        out.push({
          id: b.id,
          name: b.name,
          status: b.status,
          sessionsTotal: b.sessionsTotal,
          expiresOn: b.expiresOn ? fromDbDate(b.expiresOn) : null,
          trainer: b.trainer?.visibleToMembers ? b.trainer.displayName : null,
          ...(await balanceSummary(tx, b.id)),
        });
      }
      const upcoming = await tx.ptAppointment.findMany({
        where: {
          memberId: mctx.memberId,
          status: "SCHEDULED",
          endsAt: { gte: now },
        },
        orderBy: { startsAt: "asc" },
        take: 20,
        include: {
          trainer: { select: { displayName: true } },
          branch: { select: { name: true, timezone: true } },
        },
      });
      return {
        balances: out,
        upcoming: upcoming.map((a) => {
          const tz = a.branch.timezone ?? mctx.timezone;
          return {
            id: a.id,
            date: todayIn(tz, a.startsAt),
            startTime: formatClock(localMinuteOf(a.startsAt, tz)),
            trainer: a.trainer.displayName,
            branch: a.branch.name,
          };
        }),
      };
    },
    { userId: mctx.userId },
  );
}

// --- worker ---------------------------------------------------------------------------------

/** Daily: active packages past their last day expire; their remaining sessions are written off. */
export async function expirePtBalances(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
) {
  const due = await tx.ptPackageBalance.findMany({
    where: { status: "ACTIVE", expiresOn: { lt: toDbDate(today) } },
    select: { id: true, memberId: true, branchId: true },
  });
  for (const b of due) {
    const left = await ptSessionBalance(tx, b.id);
    await tx.ptPackageBalance.update({
      where: { id: b.id },
      data: { status: "EXPIRED" },
    });
    if (left > 0)
      await tx.entitlementLedger.create({
        data: {
          tenantId,
          memberId: b.memberId,
          kind: "PT_SESSION",
          ptBalanceId: b.id,
          delta: -left,
          reason: "EXPIRED",
          note: `Package expired with ${left} session(s) unused`,
        },
      });
    await tx.ptAppointment.updateMany({
      where: { balanceId: b.id, status: "SCHEDULED" },
      data: {
        status: "CANCELLED",
        cancelReason: "Package expired",
        cancelledAt: new Date(),
      },
    });
  }
  if (due.length)
    await recordAudit(
      tx,
      { system: true, tenantId },
      {
        action: "pt_packages.expired",
        entityType: "PtPackageBalance",
        meta: { count: due.length },
      },
    );
  return { expired: due.length };
}
