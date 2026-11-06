import type { PrismaClient, TenantTransaction } from "@gym/db";
import { withTenant } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { hasPermission, requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { emitEvent } from "../events";
import { notify } from "../notifications";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { localDateTimeToUtc, todayIn } from "../time/dates";
import { parseInput } from "../validation";
import { leadName, moveToStageTx, scoreTx } from "./leads";
import { newTrialPassCode, parseTrialQr, TRIAL_QR_PREFIX } from "./rules";
import { crmGuard, stageFor } from "./setup";
import { markNoShowTx } from "./tasks";

const bookSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("SLOT"),
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time."),
    minutes: z.coerce.number().int().min(15).max(240).default(60),
    trainerUserId: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.uuid().optional(),
    ),
    notes: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => v || null),
    sendConfirmation: z
      .union([z.literal("on"), z.literal(""), z.boolean()])
      .optional()
      .transform((v) => v === "on" || v === true),
  }),
  z.object({
    mode: z.literal("CLASS"),
    classSessionId: z.uuid("Pick a class."),
    notes: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => v || null),
    sendConfirmation: z
      .union([z.literal("on"), z.literal(""), z.boolean()])
      .optional()
      .transform((v) => v === "on" || v === true),
  }),
]);

/**
 * Books a trial for a lead: a free slot, or a seat in a class (same capacity rule as members:
 * one conditional UPDATE, so the last seat can't be taken twice). Moves the lead to Trial
 * scheduled (forward only), adds a follow-up task after the trial, optionally emails the pass.
 */
export async function bookTrial(
  deps: CoreDeps,
  ctx: AuthContext,
  leadId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const input = parseInput(bookSchema, raw);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
      include: { stage: true, branch: true },
    });
    if (!lead || !hasPermission(ctx, "leads.view", { branchId: lead.branchId }))
      throw new AppError("NOT_FOUND", "Lead not found.");
    requirePermission(ctx, "leads.manage", { branchId: lead.branchId });
    if (lead.status !== "OPEN")
      throw new AppError("CONFLICT", "Reopen the lead before booking a trial.");
    let startsAt: Date;
    let endsAt: Date;
    let classSessionId: string | null = null;
    let label: string;
    if (input.mode === "CLASS") {
      const session = await tx.classSession.findUnique({
        where: { id: input.classSessionId },
      });
      if (!session || session.status !== "SCHEDULED")
        throw new AppError("NOT_FOUND", "Class not found.");
      if (session.branchId !== lead.branchId)
        throw new AppError(
          "VALIDATION_FAILED",
          "Pick a class at the lead's branch.",
        );
      if (session.startsAt <= now)
        throw new AppError("CONFLICT", "This class has already started.");
      const taken = await tx.$executeRaw`
        UPDATE app.class_session SET booked_count = booked_count + 1
         WHERE id = ${session.id}::uuid AND status = 'SCHEDULED' AND booked_count < capacity`;
      if (taken !== 1) throw new AppError("CONFLICT", "This class is full.");
      startsAt = session.startsAt;
      endsAt = session.endsAt;
      classSessionId = session.id;
      label = session.name;
    } else {
      startsAt = localDateTimeToUtc(input.start, ctx.timezone);
      endsAt = new Date(startsAt.getTime() + input.minutes * 60_000);
      if (startsAt.getTime() < now.getTime() - 3_600_000)
        throw new AppError("VALIDATION_FAILED", "Pick a time from now on.", {
          fields: { start: ["In the past."] },
        });
      label = "Gym trial";
    }
    let trial;
    try {
      trial = await tx.trialBooking.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: lead.branchId,
          leadId: lead.id,
          classSessionId,
          startsAt,
          endsAt,
          trainerUserId:
            input.mode === "SLOT" ? (input.trainerUserId ?? null) : null,
          passCode: newTrialPassCode(),
          notes: input.notes,
          createdById: ctx.userId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002")
        throw new AppError(
          "CONFLICT",
          "This lead already has a trial in that class.",
        );
      throw err;
    }
    const when = startsAt.toLocaleString("en-IN", {
      timeZone: ctx.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    await tx.leadActivity.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: lead.id,
        type: "TRIAL",
        body: `Trial booked: ${label}, ${when}`,
        meta: { trialId: trial.id },
        userId: ctx.userId,
      },
    });
    if (lead.stage.category !== "TRIAL_SCHEDULED")
      await moveToStageTx(
        tx,
        ctx,
        ctx.tenantId,
        lead,
        await stageFor(tx, ctx.tenantId, "TRIAL_SCHEDULED"),
        {
          onlyForward: true,
          reason: "trial booked",
        },
      );
    await tx.followUpTask.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: lead.branchId,
        kind: "TRIAL",
        title: `After the trial: talk to ${leadName(lead)} about joining`,
        dueAt: new Date(endsAt.getTime() + 30 * 60_000),
        assigneeUserId: lead.ownerUserId ?? ctx.userId,
        leadId: lead.id,
        createdById: ctx.userId,
      },
    });
    await scoreTx(tx, lead.id, now);
    await emitEvent(tx, ctx.tenantId, "trial.booked", {
      trialId: trial.id,
      leadId: lead.id,
      startsAt: startsAt.toISOString(),
      classSessionId,
    });
    await recordAudit(tx, ctx, {
      action: "trial.booked",
      entityType: "TrialBooking",
      entityId: trial.id,
      branchId: lead.branchId,
      after: { classSessionId, startsAt },
    });
    if (input.sendConfirmation && (lead.email || lead.phone)) {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
      });
      await notify(tx, ctx.tenantId, {
        templateKey: "trial.booked",
        recipient: { email: lead.email, leadId: lead.id, phone: lead.phone },
        // M6: also on WhatsApp when the gym mapped an approved template to this message.
        channels: ["EMAIL", "WHATSAPP"],
        data: {
          name: lead.firstName,
          gym: tenant.displayName,
          branch: lead.branch.name,
          when,
          link: deps.appUrl
            ? `${deps.appUrl}/t/${trial.passCode}`
            : `/t/${trial.passCode}`,
        },
        dedupeKey: `trial-booked:${trial.id}`,
      });
    }
    return trial;
  });
}

async function loadTrial(
  tx: TenantTransaction,
  ctx: AuthContext,
  trialId: string,
) {
  const trial = await tx.trialBooking.findUnique({
    where: { id: trialId },
    include: { lead: { include: { stage: true } } },
  });
  if (!trial || !hasPermission(ctx, "leads.view", { branchId: trial.branchId }))
    throw new AppError("NOT_FOUND", "Trial not found.");
  return trial;
}

export async function cancelTrial(
  deps: CoreDeps,
  ctx: AuthContext,
  trialId: string,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const trial = await loadTrial(tx, ctx, trialId);
    requirePermission(ctx, "leads.manage", { branchId: trial.branchId });
    const { count } = await tx.trialBooking.updateMany({
      where: { id: trial.id, status: "BOOKED" },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    if (!count)
      throw new AppError("CONFLICT", "This trial isn't booked any more.");
    if (trial.classSessionId)
      await tx.$executeRaw`UPDATE app.class_session SET booked_count = booked_count - 1 WHERE id = ${trial.classSessionId}::uuid AND booked_count > 0`;
    await tx.leadActivity.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: trial.leadId,
        type: "TRIAL",
        body: "Trial cancelled",
        meta: { trialId: trial.id },
        userId: ctx.userId,
      },
    });
    await tx.followUpTask.updateMany({
      where: { leadId: trial.leadId, kind: "TRIAL", status: "OPEN" },
      data: {
        status: "CANCELLED",
        completedAt: now,
        completedById: ctx.userId,
        outcome: "Trial cancelled",
      },
    });
    await scoreTx(tx, trial.leadId, now);
    await emitEvent(tx, ctx.tenantId, "trial.cancelled", {
      trialId: trial.id,
      leadId: trial.leadId,
    });
    await recordAudit(tx, ctx, {
      action: "trial.cancelled",
      entityType: "TrialBooking",
      entityId: trial.id,
      branchId: trial.branchId,
    });
  });
}

async function attendTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  trial: Awaited<ReturnType<typeof loadTrial>>,
  via: "MANUAL" | "QR",
  now: Date,
) {
  const { count } = await tx.trialBooking.updateMany({
    where: { id: trial.id, status: { in: ["BOOKED", "NO_SHOW"] } },
    data: { status: "ATTENDED", attendedAt: now, attendedVia: via },
  });
  if (!count) return false;
  await tx.leadActivity.create({
    data: {
      tenantId: ctx.tenantId,
      leadId: trial.leadId,
      type: "TRIAL",
      body:
        via === "QR"
          ? "Came for the trial (trial pass scanned)"
          : "Came for the trial",
      meta: { trialId: trial.id },
      userId: ctx.userId,
    },
  });
  if (trial.lead.status === "OPEN")
    await moveToStageTx(
      tx,
      ctx,
      ctx.tenantId,
      trial.lead,
      await stageFor(tx, ctx.tenantId, "TRIAL_ATTENDED"),
      {
        onlyForward: true,
        reason: "trial attended",
      },
    );
  await scoreTx(tx, trial.leadId, now);
  await emitEvent(tx, ctx.tenantId, "trial.attended", {
    trialId: trial.id,
    leadId: trial.leadId,
  });
  await recordAudit(tx, ctx, {
    action: "trial.attended",
    entityType: "TrialBooking",
    entityId: trial.id,
    branchId: trial.branchId,
    meta: { via },
  });
  return true;
}

/** Front desk marks a trial as attended (manual check-in) or as a no-show. */
export async function markTrial(
  deps: CoreDeps,
  ctx: AuthContext,
  trialId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.manage", { write: true });
  const { outcome } = parseInput(
    z.object({ outcome: z.enum(["ATTENDED", "NO_SHOW"]) }),
    raw,
  );
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const trial = await loadTrial(tx, ctx, trialId);
    requirePermission(ctx, "leads.manage", { branchId: trial.branchId });
    if (trial.startsAt.getTime() > now.getTime() + 3 * 3_600_000)
      throw new AppError("CONFLICT", "This trial hasn't happened yet.");
    const done =
      outcome === "ATTENDED"
        ? await attendTx(tx, ctx, trial, "MANUAL", now)
        : await markNoShowTx(tx, ctx, ctx.tenantId, trial, now);
    if (!done)
      throw new AppError("CONFLICT", "This trial has already been marked.");
  });
}

/**
 * Scanner: a trial pass (`GT1.<code>`) checks the lead in for their trial. Valid at the trial's
 * branch, on the trial's local date, once. Codes from another gym look like any unknown code.
 */
export async function scanTrialPass(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: { code: string; branchId: string },
): Promise<
  { ok: true; name: string; when: string } | { ok: false; reason: string }
> {
  await crmGuard(deps, ctx, "leads.manage", {
    write: true,
    branchId: raw.branchId,
  });
  const code = parseTrialQr(raw.code);
  if (!code) return { ok: false, reason: "This isn't a trial pass." };
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const [found] = await tx.$queryRaw<
      { tenant_id: string; trial_id: string }[]
    >`
      SELECT tenant_id::text, trial_id::text FROM app.trial_pass_lookup(${code})`;
    if (!found || found.tenant_id !== ctx.tenantId)
      return { ok: false, reason: "Unknown trial pass." };
    const trial = await loadTrial(tx, ctx, found.trial_id);
    if (trial.branchId !== raw.branchId)
      return { ok: false, reason: "This trial is booked at another branch." };
    if (todayIn(ctx.timezone, trial.startsAt) !== todayIn(ctx.timezone, now))
      return { ok: false, reason: "This trial pass is for another day." };
    if (trial.status === "ATTENDED")
      return { ok: false, reason: "Already checked in for this trial." };
    if (trial.status === "CANCELLED")
      return { ok: false, reason: "This trial was cancelled." };
    await attendTx(tx, ctx, trial, "QR", now);
    return {
      ok: true,
      name: leadName(trial.lead),
      when: trial.startsAt.toLocaleTimeString("en-IN", {
        timeZone: ctx.timezone,
        timeStyle: "short",
      }),
    };
  });
}

export const isTrialQr = (raw: string) =>
  raw.trim().startsWith(TRIAL_QR_PREFIX);

/** Upcoming classes at a branch with a free seat (the trial booking picker), next 14 days. */
export async function trialClassOptions(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId: string,
) {
  await crmGuard(deps, ctx, "leads.view");
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.classSession.findMany({
      where: {
        branchId,
        status: "SCHEDULED",
        startsAt: { gt: now, lt: new Date(now.getTime() + 14 * 86_400_000) },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
    });
    return rows
      .filter((s) => s.bookedCount < s.capacity)
      .map((s) => ({
        id: s.id,
        label: `${s.startsAt.toLocaleString("en-IN", { timeZone: ctx.timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${s.name} (${s.capacity - s.bookedCount} left)`,
      }));
  });
}

/** Trials for a day at a branch (front desk list), and per class session (roster). */
export async function listTrials(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "leads.view");
  const f = parseInput(
    z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      branchId: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.uuid().optional(),
      ),
      classSessionId: z.uuid().optional(),
    }),
    raw,
  );
  const date = f.date ?? todayIn(ctx.timezone, nowOf(deps));
  const start = localDateTimeToUtc(`${date}T00:00`, ctx.timezone);
  const end = new Date(start.getTime() + 86_400_000);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.trialBooking.findMany({
      where: f.classSessionId
        ? { classSessionId: f.classSessionId, status: { not: "CANCELLED" } }
        : {
            startsAt: { gte: start, lt: end },
            ...(f.branchId ? { branchId: f.branchId } : {}),
          },
      orderBy: { startsAt: "asc" },
      include: {
        lead: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            status: true,
          },
        },
        classSession: { select: { id: true, name: true } },
        branch: { select: { name: true } },
      },
    });
    return {
      date,
      rows: rows
        .filter((t) =>
          hasPermission(ctx, "leads.view", { branchId: t.branchId }),
        )
        .map((t) => ({ ...t, lead: { ...t.lead, name: leadName(t.lead) } })),
    };
  });
}

/** Public trial pass page (/t/{code}): no personal data, only what the person needs to show. */
export async function trialPassView(db: PrismaClient, passCode: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(passCode)) return null;
  const [found] = await db.$queryRaw<{ tenant_id: string; trial_id: string }[]>`
    SELECT tenant_id::text, trial_id::text FROM app.trial_pass_lookup(${passCode})`;
  if (!found) return null;
  return withTenant(db, found.tenant_id, async (tx) => {
    const trial = await tx.trialBooking.findUnique({
      where: { id: found.trial_id },
      include: {
        branch: { select: { name: true, addressLine1: true, city: true } },
        classSession: { select: { name: true } },
      },
    });
    if (!trial) return null;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: found.tenant_id },
    });
    return {
      gym: tenant.displayName,
      timezone: tenant.timezone,
      branch: trial.branch.name,
      address: [trial.branch.addressLine1, trial.branch.city]
        .filter(Boolean)
        .join(", "),
      what: trial.classSession?.name ?? "Gym trial",
      startsAt: trial.startsAt,
      status: trial.status,
      qr: `${TRIAL_QR_PREFIX}${trial.passCode}`,
    };
  });
}
