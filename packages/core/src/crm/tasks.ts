import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import { emitEvent } from "../events";
import { memberName } from "../members/service";
import { notify } from "../notifications";
import { inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  localDateTimeToUtc,
  startOfDayUtc,
  todayIn,
} from "../time/dates";
import { parseInput } from "../validation";
import { crmStaff, leadName, moveToStageTx, scoreTx } from "./leads";
import { crmGuard, stageFor } from "./setup";

const optionalUuid = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.uuid().optional(),
);

const taskSchema = z
  .object({
    title: z.string().trim().min(3, "Say what needs doing.").max(140),
    notes: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => v || null),
    /** Local date-time in the gym's timezone, "YYYY-MM-DDTHH:mm". */
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a due date and time."),
    kind: z
      .enum(["FOLLOW_UP", "CALLBACK", "TRIAL", "OTHER"])
      .default("FOLLOW_UP"),
    assigneeUserId: optionalUuid,
    leadId: optionalUuid,
    memberId: optionalUuid,
    branchId: optionalUuid,
  })
  .refine((v) => !(v.leadId && v.memberId), {
    path: ["leadId"],
    message: "A task is for a lead or a member, not both.",
  });

/** A follow-up task for a lead, a member, or just the branch. */
export async function createTask(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "tasks.manage", { write: true });
  const input = parseInput(taskSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    let branchId = input.branchId ?? ctx.activeBranchId;
    let leadLabel: string | null = null;
    if (input.leadId) {
      const lead = await tx.lead.findUnique({ where: { id: input.leadId } });
      if (
        !lead ||
        !hasPermission(ctx, "leads.view", { branchId: lead.branchId })
      )
        throw new AppError("NOT_FOUND", "Lead not found.");
      branchId = lead.branchId;
      leadLabel = leadName(lead);
    }
    if (input.memberId) {
      const member = await tx.memberProfile.findUnique({
        where: { id: input.memberId },
      });
      if (
        !member ||
        !hasPermission(ctx, "members.view", { branchId: member.homeBranchId })
      )
        throw new AppError("NOT_FOUND", "Member not found.");
      branchId = member.homeBranchId;
    }
    if (!branchId) {
      const first = await tx.branch.findFirst({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });
      branchId = first?.id ?? null;
    }
    if (!branchId) throw new AppError("VALIDATION_FAILED", "Pick a branch.");
    requirePermission(ctx, "tasks.manage", { branchId });
    const assignee = input.assigneeUserId ?? ctx.userId;
    if (assignee !== ctx.userId) {
      const staff = await crmStaff(tx, branchId);
      if (!staff.some((s) => s.userId === assignee))
        throw new AppError(
          "VALIDATION_FAILED",
          "Pick someone who works this branch.",
          {
            fields: { assigneeUserId: ["Pick someone else."] },
          },
        );
    }
    const dueAt = localDateTimeToUtc(input.due, ctx.timezone);
    const task = await tx.followUpTask.create({
      data: {
        tenantId: ctx.tenantId,
        branchId,
        kind: input.kind,
        title: input.title,
        notes: input.notes,
        dueAt,
        assigneeUserId: assignee,
        leadId: input.leadId ?? null,
        memberId: input.memberId ?? null,
        createdById: ctx.userId,
      },
    });
    if (input.leadId)
      await tx.leadActivity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: input.leadId,
          type: "TASK",
          body: `Task added: ${input.title}`,
          meta: { taskId: task.id },
          userId: ctx.userId,
        },
      });
    if (assignee !== ctx.userId)
      await notify(tx, ctx.tenantId, {
        templateKey: "task.assigned",
        recipient: { userId: assignee },
        channels: ["IN_APP"],
        data: {
          task: input.title,
          due: input.due.replace("T", " "),
          by: "A colleague",
          lead: leadLabel ?? "",
        },
        link: input.leadId ? `/leads/${input.leadId}` : "/tasks",
      });
    return task;
  });
}

const listSchema = z.object({
  scope: z.enum(["mine", "team"]).default("mine"),
  when: z.enum(["overdue", "today", "upcoming", "all", "done"]).default("all"),
  assignee: optionalUuid,
  branchId: optionalUuid,
});

/** "My tasks" (default) or the team's (needs leads.assign), with overdue first. */
export async function listTasks(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "tasks.manage");
  const f = parseInput(listSchema, raw);
  const now = nowOf(deps);
  const endOfDay = endOfLocalDay(now, ctx.timezone);
  const where: Prisma.FollowUpTaskWhereInput[] = [];
  if (f.scope === "mine") where.push({ assigneeUserId: ctx.userId });
  else {
    requirePermission(ctx, "leads.assign");
    const allowed = allowedBranchIds(ctx, "leads.assign");
    if (allowed !== "ALL") where.push({ branchId: { in: allowed } });
    if (f.assignee) where.push({ assigneeUserId: f.assignee });
  }
  if (f.branchId) where.push({ branchId: f.branchId });
  if (f.when === "done") where.push({ status: { in: ["DONE", "CANCELLED"] } });
  else {
    where.push({ status: "OPEN" });
    if (f.when === "overdue") where.push({ dueAt: { lt: now } });
    if (f.when === "today") where.push({ dueAt: { gte: now, lt: endOfDay } });
    if (f.when === "upcoming") where.push({ dueAt: { gte: endOfDay } });
  }
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.followUpTask.findMany({
      where: { AND: where },
      orderBy: f.when === "done" ? { completedAt: "desc" } : { dueAt: "asc" },
      take: 200,
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
        member: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
        branch: { select: { name: true } },
      },
    });
    const staff = await crmStaff(tx, null);
    const names = new Map(staff.map((s) => [s.userId, s.name]));
    return {
      filters: f,
      rows: rows.map((t) => ({
        ...t,
        overdue: t.status === "OPEN" && t.dueAt < now,
        assignee: t.assigneeUserId
          ? (names.get(t.assigneeUserId) ?? "Former staff")
          : null,
        lead: t.lead ? { ...t.lead, name: leadName(t.lead) } : null,
        member: t.member ? { ...t.member, name: memberName(t.member) } : null,
      })),
    };
  });
}

/** Open overdue tasks for the nav badge. */
export async function myOverdueCount(deps: CoreDeps, ctx: AuthContext) {
  if (!hasPermission(ctx, "tasks.manage")) return 0;
  return inTenant(deps, ctx, (tx) =>
    tx.followUpTask.count({
      where: {
        assigneeUserId: ctx.userId,
        status: "OPEN",
        dueAt: { lt: nowOf(deps) },
      },
    }),
  );
}

async function loadTask(
  tx: TenantTransaction,
  ctx: AuthContext,
  taskId: string,
) {
  const task = await tx.followUpTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError("NOT_FOUND", "Task not found.");
  // Your own task, or a manager over that branch.
  if (
    task.assigneeUserId !== ctx.userId &&
    !hasPermission(ctx, "leads.assign", { branchId: task.branchId })
  )
    throw new AppError(
      "FORBIDDEN",
      "Only the person it's assigned to (or a manager) can change this task.",
    );
  return task;
}

export async function completeTask(
  deps: CoreDeps,
  ctx: AuthContext,
  taskId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "tasks.manage", { write: true });
  const { outcome } = parseInput(
    z.object({
      outcome: z
        .string()
        .trim()
        .max(300)
        .optional()
        .transform((v) => v || null),
    }),
    raw,
  );
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const task = await loadTask(tx, ctx, taskId);
    if (task.status !== "OPEN") return task;
    await tx.followUpTask.update({
      where: { id: task.id },
      data: {
        status: "DONE",
        completedAt: now,
        completedById: ctx.userId,
        outcome,
      },
    });
    if (task.leadId) {
      await tx.leadActivity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: task.leadId,
          type: "TASK",
          body: `Done: ${task.title}${outcome ? ` — ${outcome}` : ""}`,
          meta: { taskId: task.id },
          userId: ctx.userId,
        },
      });
      // Finishing the first-contact task counts as the first contact.
      if (task.kind === "FIRST_CONTACT") {
        const lead = await tx.lead.findUniqueOrThrow({
          where: { id: task.leadId },
          include: { stage: true },
        });
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            lastContactedAt: now,
            ...(lead.firstContactedAt ? {} : { firstContactedAt: now }),
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
        await scoreTx(tx, lead.id, now);
      }
    }
  });
}

export async function cancelTask(
  deps: CoreDeps,
  ctx: AuthContext,
  taskId: string,
) {
  await crmGuard(deps, ctx, "tasks.manage", { write: true });
  return inTenant(deps, ctx, async (tx) => {
    const task = await loadTask(tx, ctx, taskId);
    if (task.status !== "OPEN") return;
    await tx.followUpTask.update({
      where: { id: task.id },
      data: {
        status: "CANCELLED",
        completedAt: nowOf(deps),
        completedById: ctx.userId,
      },
    });
  });
}

export async function rescheduleTask(
  deps: CoreDeps,
  ctx: AuthContext,
  taskId: string,
  raw: unknown,
) {
  await crmGuard(deps, ctx, "tasks.manage", { write: true });
  const { due } = parseInput(z.object({ due: taskSchema.shape.due }), raw);
  return inTenant(deps, ctx, async (tx) => {
    const task = await loadTask(tx, ctx, taskId);
    if (task.status !== "OPEN")
      throw new AppError("CONFLICT", "This task is closed.");
    await tx.followUpTask.update({
      where: { id: task.id },
      data: { dueAt: localDateTimeToUtc(due, ctx.timezone), remindedAt: null },
    });
  });
}

function endOfLocalDay(now: Date, timezone: string): Date {
  return startOfDayUtc(addDays(todayIn(timezone, now), 1), timezone);
}

// --- the CRM tick (worker, every 5 minutes per tenant) --------------------------------------------

const NO_SHOW_AFTER_MS = 2 * 3_600_000;

/**
 * 1. First-contact SLA: open leads never contacted past the SLA → event (once per lead).
 * 2. Task reminders: open tasks due within the reminder window → in-app + email (once per task).
 * 3. Trials still BOOKED two hours after they ended → no-show (stage back to Contacted, follow-up task).
 */
export async function crmTick(
  tx: TenantTransaction,
  tenantId: string,
  now: Date,
) {
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const slaMinutes = settings?.leadFirstContactMinutes ?? 15;
  const result = { slaBreached: 0, reminded: 0, noShows: 0 };

  const late = await tx.lead.findMany({
    where: {
      status: "OPEN",
      firstContactedAt: null,
      slaBreachedAt: null,
      createdAt: { lt: new Date(now.getTime() - slaMinutes * 60_000) },
    },
    take: 200,
  });
  for (const lead of late) {
    const { count } = await tx.lead.updateMany({
      where: { id: lead.id, slaBreachedAt: null },
      data: { slaBreachedAt: now },
    });
    if (!count) continue;
    await emitEvent(tx, tenantId, "lead.uncontacted_sla_breached", {
      leadId: lead.id,
      ownerUserId: lead.ownerUserId,
      minutes: slaMinutes,
    });
    result.slaBreached++;
  }

  const reminderMinutes = settings?.taskReminderMinutes ?? 30;
  if (reminderMinutes > 0) {
    const due = await tx.followUpTask.findMany({
      where: {
        status: "OPEN",
        remindedAt: null,
        assigneeUserId: { not: null },
        dueAt: {
          lte: new Date(now.getTime() + reminderMinutes * 60_000),
          gte: new Date(now.getTime() - 24 * 3_600_000),
        },
      },
      take: 500,
    });
    const staff = await crmStaff(tx, null, [
      "GYM_OWNER",
      "GYM_ADMIN",
      "BRANCH_MANAGER",
      "RECEPTIONIST",
      "SALES_STAFF",
      "TRAINER",
      "ACCOUNTANT",
    ]);
    const byId = new Map(staff.map((s) => [s.userId, s]));
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    for (const task of due) {
      const { count } = await tx.followUpTask.updateMany({
        where: { id: task.id, remindedAt: null },
        data: { remindedAt: now },
      });
      if (!count) continue;
      const person = byId.get(task.assigneeUserId!);
      if (!person) continue;
      await notify(tx, tenantId, {
        templateKey: "task.reminder",
        recipient: { userId: person.userId, email: person.email },
        data: {
          task: task.title,
          due: task.dueAt.toLocaleString("en-IN", {
            timeZone: tenant.timezone,
            dateStyle: "medium",
            timeStyle: "short",
          }),
        },
        link: task.leadId ? `/leads/${task.leadId}` : "/tasks",
        dedupeKey: `task-reminder:${task.id}:${task.dueAt.toISOString()}`,
      });
      result.reminded++;
    }
  }

  const missed = await tx.trialBooking.findMany({
    where: {
      status: "BOOKED",
      endsAt: { lt: new Date(now.getTime() - NO_SHOW_AFTER_MS) },
    },
    include: { lead: { include: { stage: true } } },
    take: 200,
  });
  for (const trial of missed) {
    await markNoShowTx(tx, { system: true, tenantId }, tenantId, trial, now);
    result.noShows++;
  }
  return result;
}

/** No-show: stage back to Contacted (if the lead was waiting for this trial) and a follow-up task. */
export async function markNoShowTx(
  tx: TenantTransaction,
  actor: Parameters<typeof moveToStageTx>[1],
  tenantId: string,
  trial: {
    id: string;
    leadId: string;
    branchId: string;
    lead: {
      id: string;
      stageId: string;
      branchId: string;
      status: string;
      ownerUserId: string | null;
      firstName: string;
      lastName: string | null;
      stage: { category: string };
    };
  },
  now: Date,
) {
  const { count } = await tx.trialBooking.updateMany({
    where: { id: trial.id, status: "BOOKED" },
    data: { status: "NO_SHOW" },
  });
  if (!count) return false;
  await tx.leadActivity.create({
    data: {
      tenantId,
      leadId: trial.leadId,
      type: "TRIAL",
      body: "Didn't come for the trial",
      meta: { trialId: trial.id },
    },
  });
  if (trial.lead.status === "OPEN") {
    if (trial.lead.stage.category === "TRIAL_SCHEDULED")
      await moveToStageTx(
        tx,
        actor,
        tenantId,
        trial.lead,
        await stageFor(tx, tenantId, "CONTACTED"),
        { reason: "missed trial" },
      );
    await tx.followUpTask.create({
      data: {
        tenantId,
        branchId: trial.branchId,
        kind: "CALLBACK",
        title: `Missed trial: call ${leadName(trial.lead)}`,
        dueAt: now,
        assigneeUserId: trial.lead.ownerUserId,
        leadId: trial.leadId,
      },
    });
  }
  await scoreTx(tx, trial.leadId, now);
  await emitEvent(tx, tenantId, "trial.no_show", {
    trialId: trial.id,
    leadId: trial.leadId,
  });
  await recordAudit(tx, actor, {
    action: "trial.no_show",
    entityType: "TrialBooking",
    entityId: trial.id,
    branchId: trial.branchId,
  });
  return true;
}
