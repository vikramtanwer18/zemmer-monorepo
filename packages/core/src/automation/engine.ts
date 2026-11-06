import { withTenant, type Prisma, type TenantTransaction } from "@gym/db";
import { recordAudit } from "../audit";
import { invoiceBalances } from "../billing/service";
import { moveToStageTx, reassignTx, roundRobinOwner } from "../crm/leads";
import { isFeatureEnabled, loadEntitlements } from "../entitlements";
import {
  EVENT_TYPES,
  type DomainEvent,
  type EventHandler,
  type EventType,
} from "../events";
import { segmentDefinitionSchema } from "../growth/segment-dsl";
import { inSegmentTx } from "../growth/segments";
import { factsForSubjectTx } from "../messaging/facts";
import { queueMessageTx } from "../messaging/send";
import { resolveVariables } from "../messaging/variables";
import { notify, renderTemplate } from "../notifications";
import { nowOf, type CoreDeps } from "../tenancy/deps";
import { addDays, fromDbDate, toDbDate, type LocalDate } from "../time/dates";
import {
  EVENT_TRIGGERS,
  evaluateConditions,
  scanTriggerKey,
  subjectOf,
  workflowDefinitionSchema,
  type ExitWhen,
  type ScanTrigger,
  type Step,
  type TriggerType,
  type WorkflowDefinition,
} from "./definition";

/**
 * Automation engine (M6 §5). A trigger (domain event or daily scan hit) starts at most one
 * execution per (workflow version, trigger key) — enforced by a unique index — and never a second
 * one for the same workflow and key across versions. Each step runs in its own transaction that
 * also writes its AutomationStepRun (unique per execution and step), so a retried job continues
 * where it stopped and never repeats an action.
 */

export type Subject = {
  memberId: string | null;
  leadId: string | null;
  branchId: string | null;
  planId: string | null;
  amountMinor: number | null;
  leadSourceId: string | null;
  context: Record<string, string | number | boolean | null>;
};

export type Trigger = {
  type: TriggerType;
  key: string;
  days?: number;
  retentionKind?: string;
};

type LoadedWorkflow = {
  id: string;
  name: string;
  versionId: string;
  definition: WorkflowDefinition;
};

export async function loadEnabledWorkflowsTx(
  tx: TenantTransaction,
): Promise<LoadedWorkflow[]> {
  const rows = await tx.automationWorkflow.findMany({
    where: { enabled: true, archivedAt: null, currentVersionId: { not: null } },
    select: { id: true, name: true, currentVersionId: true },
  });
  if (!rows.length) return [];
  const versions = await tx.automationWorkflowVersion.findMany({
    where: { id: { in: rows.map((r) => r.currentVersionId!) } },
  });
  const out: LoadedWorkflow[] = [];
  for (const r of rows) {
    const v = versions.find((x) => x.id === r.currentVersionId);
    const parsed = v ? workflowDefinitionSchema.safeParse(v.definition) : null;
    if (v && parsed?.success)
      out.push({
        id: r.id,
        name: r.name,
        versionId: v.id,
        definition: parsed.data,
      });
  }
  return out;
}

function matches(
  def: WorkflowDefinition,
  trigger: Trigger,
  subject: Subject,
): boolean {
  if (def.trigger.type !== trigger.type) return false;
  if (trigger.days !== undefined && def.trigger.days !== trigger.days)
    return false;
  if (
    trigger.type === "retention.flagged" &&
    def.trigger.retentionKinds?.length &&
    !def.trigger.retentionKinds.includes(trigger.retentionKind as never)
  )
    return false;
  if (
    subjectOf(def.trigger.type) === "LEAD" ? !subject.leadId : !subject.memberId
  )
    return false;
  return true;
}

export async function conditionsHoldTx(
  tx: TenantTransaction,
  def: WorkflowDefinition,
  subject: Subject,
  now: Date,
  timeZone: string,
) {
  const segments = new Set<string>();
  for (const c of def.conditions)
    if (c.field === "segment") {
      const seg = await tx.segment.findUnique({ where: { id: c.value } });
      const parsed =
        seg && !seg.archivedAt
          ? segmentDefinitionSchema.safeParse(seg.definition)
          : null;
      if (
        parsed?.success &&
        (await inSegmentTx(tx, parsed.data, subject, { now, timeZone }))
      )
        segments.add(c.value);
    }
  return evaluateConditions(def.conditions, {
    branchId: subject.branchId,
    planId: subject.planId,
    amountMinor: subject.amountMinor,
    leadSourceId: subject.leadSourceId,
    segments,
  });
}

/** Starts matching workflows for one trigger, in the caller's transaction. Returns new execution ids. */
export async function startExecutionsTx(
  tx: TenantTransaction,
  tenantId: string,
  trigger: Trigger,
  subject: Subject,
  now: Date,
  workflows?: LoadedWorkflow[],
): Promise<string[]> {
  const ent = await loadEntitlements(tx, tenantId, now);
  if (!isFeatureEnabled(ent, "automation.enabled")) return [];
  const list = workflows ?? (await loadEnabledWorkflowsTx(tx));
  const started: string[] = [];
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  for (const wf of list) {
    if (!matches(wf.definition, trigger, subject)) continue;
    if (
      !(await conditionsHoldTx(
        tx,
        wf.definition,
        subject,
        now,
        tenant.timezone,
      ))
    )
      continue;
    // Never twice for the same workflow and trigger, even after the workflow was edited.
    const before = await tx.automationExecution.findFirst({
      where: { workflowId: wf.id, triggerKey: trigger.key },
      select: { id: true },
    });
    if (before) continue;
    const created = await tx.automationExecution.createMany({
      data: [
        {
          tenantId,
          workflowId: wf.id,
          versionId: wf.versionId,
          triggerKey: trigger.key,
          triggerType: trigger.type,
          memberId: subject.memberId,
          leadId: subject.leadId,
          context: {
            ...subject.context,
            branchId: subject.branchId,
          } as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) continue;
    const row = await tx.automationExecution.findUniqueOrThrow({
      where: {
        tenantId_versionId_triggerKey: {
          tenantId,
          versionId: wf.versionId,
          triggerKey: trigger.key,
        },
      },
      select: { id: true },
    });
    await tx.outbox.create({
      data: {
        tenantId,
        topic: "automation.run",
        payload: { executionId: row.id },
      },
    });
    started.push(row.id);
  }
  return started;
}

// --- event triggers -------------------------------------------------------------------------------

async function leadSubject(
  tx: TenantTransaction,
  leadId: string,
  context: Subject["context"],
): Promise<Subject | null> {
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    select: { branchId: true, sourceId: true },
  });
  if (!lead) return null;
  return {
    memberId: null,
    leadId,
    branchId: lead.branchId,
    planId: null,
    amountMinor: null,
    leadSourceId: lead.sourceId,
    context,
  };
}

export async function subjectForEventTx(
  tx: TenantTransaction,
  event: DomainEvent,
): Promise<Subject | null> {
  const d = event.data as Record<string, string | number | boolean | null>;
  const ctx = { ...d, eventId: event.eventId, eventType: event.type };
  switch (event.type) {
    case "lead.converted": {
      const s = await leadSubject(tx, String(d.leadId), ctx);
      if (!s) return null;
      const ms = await tx.membership.findUnique({
        where: { id: String(d.membershipId) },
        select: { planId: true, priceMinor: true },
      });
      return {
        ...s,
        planId: ms?.planId ?? null,
        amountMinor: ms ? Number(ms.priceMinor) : null,
      };
    }
    case "membership.activated":
      return {
        memberId: String(d.memberId),
        leadId: null,
        branchId: String(d.branchId),
        planId: String(d.planId),
        amountMinor: Number(d.amountMinor),
        leadSourceId: null,
        context: ctx,
      };
    case "class.booking_cancelled":
      return {
        memberId: String(d.memberId),
        leadId: null,
        branchId: String(d.branchId),
        planId: null,
        amountMinor: null,
        leadSourceId: null,
        context: ctx,
      };
    case "retention.flagged":
      if (d.leadId) return leadSubject(tx, String(d.leadId), ctx);
      return {
        memberId: d.memberId ? String(d.memberId) : null,
        leadId: null,
        branchId: d.branchId ? String(d.branchId) : null,
        planId: null,
        amountMinor: null,
        leadSourceId: null,
        context: ctx,
      };
    default:
      if (typeof d.leadId === "string") return leadSubject(tx, d.leadId, ctx);
      return null;
  }
}

const TRIGGER_EVENT_TYPES = EVENT_TYPES.filter((t) =>
  (EVENT_TRIGGERS as readonly string[]).includes(t),
) as EventType[];

/** Registered with the M5 event dispatcher: runs once per event (EventConsumption claim). */
export const AUTOMATION_EVENT_HANDLER: EventHandler = {
  name: "automation.trigger",
  types: TRIGGER_EVENT_TYPES,
  handle: async (tx, tenantId, event) => {
    const subject = await subjectForEventTx(tx, event);
    if (!subject) return;
    const data = event.data as Record<string, unknown>;
    await startExecutionsTx(
      tx,
      tenantId,
      {
        type: event.type as TriggerType,
        key: `event:${event.eventId}`,
        retentionKind: typeof data.kind === "string" ? data.kind : undefined,
      },
      subject,
      new Date(),
    );
  },
};

// --- scan triggers (daily) ------------------------------------------------------------------------

export type ScanHit = {
  refId: string;
  subject: Subject;
  triggerDate: LocalDate;
  name: string;
};

/** Who a scan trigger with `days` hits for trigger dates in [from, to] (inclusive). */
export async function scanHitsTx(
  tx: TenantTransaction,
  type: ScanTrigger,
  days: number,
  from: LocalDate,
  to: LocalDate,
): Promise<ScanHit[]> {
  if (type === "membership.expiring") {
    const rows = await tx.membership.findMany({
      where: {
        status: "ACTIVE",
        endDate: {
          gte: toDbDate(addDays(from, days)),
          lte: toDbDate(addDays(to, days)),
        },
      },
      select: {
        id: true,
        memberId: true,
        branchId: true,
        planId: true,
        priceMinor: true,
        endDate: true,
        member: { select: { firstName: true, lastName: true } },
      },
      take: 5000,
    });
    const hits: ScanHit[] = [];
    for (const m of rows) {
      // Already renewed (a later membership is lined up): nothing to remind.
      const next = await tx.membership.count({
        where: {
          memberId: m.memberId,
          id: { not: m.id },
          status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
          endDate: { gt: m.endDate },
        },
      });
      if (next) continue;
      const end = fromDbDate(m.endDate);
      hits.push({
        refId: m.id,
        triggerDate: addDays(end, -days),
        name: [m.member.firstName, m.member.lastName].filter(Boolean).join(" "),
        subject: {
          memberId: m.memberId,
          leadId: null,
          branchId: m.branchId,
          planId: m.planId,
          amountMinor: Number(m.priceMinor),
          leadSourceId: null,
          context: { membershipId: m.id, endDate: end },
        },
      });
    }
    return hits;
  }
  if (type === "membership.expired") {
    // "N days after it ended": trigger date = end date + 1 + N (N = 0: the day after the last day).
    const rows = await tx.membership.findMany({
      where: {
        status: { in: ["EXPIRED", "ACTIVE"] },
        endDate: {
          gte: toDbDate(addDays(from, -1 - days)),
          lte: toDbDate(addDays(to, -1 - days)),
        },
      },
      select: {
        id: true,
        memberId: true,
        branchId: true,
        planId: true,
        priceMinor: true,
        endDate: true,
        member: { select: { firstName: true, lastName: true, status: true } },
      },
      take: 5000,
    });
    const hits: ScanHit[] = [];
    for (const m of rows) {
      if (m.member.status === "ARCHIVED") continue;
      const current = await tx.membership.count({
        where: {
          memberId: m.memberId,
          id: { not: m.id },
          status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
          endDate: { gt: m.endDate },
        },
      });
      if (current) continue;
      const end = fromDbDate(m.endDate);
      hits.push({
        refId: m.id,
        triggerDate: addDays(end, 1 + days),
        name: [m.member.firstName, m.member.lastName].filter(Boolean).join(" "),
        subject: {
          memberId: m.memberId,
          leadId: null,
          branchId: m.branchId,
          planId: m.planId,
          amountMinor: Number(m.priceMinor),
          leadSourceId: null,
          context: { membershipId: m.id, endDate: end },
        },
      });
    }
    return hits;
  }
  // payment.overdue: an unpaid invoice whose due date was N days before the trigger date.
  const invoices = await tx.gymInvoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      dueDate: {
        gte: toDbDate(addDays(from, -days)),
        lte: toDbDate(addDays(to, -days)),
      },
    },
    select: {
      id: true,
      memberId: true,
      branchId: true,
      dueDate: true,
      number: true,
      member: { select: { firstName: true, lastName: true } },
    },
    take: 5000,
  });
  const balances = await invoiceBalances(
    tx,
    invoices.map((i) => i.id),
  );
  return invoices
    .filter((i) => (balances.get(i.id)?.outstandingMinor ?? 0) > 0)
    .map((i) => ({
      refId: i.id,
      triggerDate: addDays(fromDbDate(i.dueDate), days),
      name: [i.member.firstName, i.member.lastName].filter(Boolean).join(" "),
      subject: {
        memberId: i.memberId,
        leadId: null,
        branchId: i.branchId,
        planId: null,
        amountMinor: balances.get(i.id)?.outstandingMinor ?? 0,
        leadSourceId: null,
        context: { invoiceId: i.id, invoiceNumber: i.number },
      },
    }));
}

/** Daily, per tenant, for its local date: starts scan-triggered workflows for today's hits. */
export async function runAutomationScansTx(
  tx: TenantTransaction,
  tenantId: string,
  today: LocalDate,
  now: Date,
) {
  const workflows = (await loadEnabledWorkflowsTx(tx)).filter(
    (w) =>
      w.definition.trigger.days !== undefined &&
      !EVENT_TRIGGERS.includes(w.definition.trigger.type as never),
  );
  let started = 0;
  const done = new Set<string>();
  for (const wf of workflows) {
    const type = wf.definition.trigger.type as ScanTrigger;
    const days = wf.definition.trigger.days!;
    const key = `${type}:${days}`;
    if (done.has(key)) continue;
    done.add(key);
    for (const hit of await scanHitsTx(tx, type, days, today, today))
      started += (
        await startExecutionsTx(
          tx,
          tenantId,
          { type, days, key: scanTriggerKey(type, hit.refId, days) },
          hit.subject,
          now,
          workflows,
        )
      ).length;
  }
  return { started };
}

// --- runner ----------------------------------------------------------------------------------------

type StepOutcome =
  | "CONTINUE"
  | "WAITING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "EXITED"
  | "CANCELLED"
  | "FAILED"
  | "NOOP";

async function goalReached(
  tx: TenantTransaction,
  exec: {
    memberId: string | null;
    leadId: string | null;
    startedAt: Date;
    context: unknown;
  },
  exits: readonly ExitWhen[],
) {
  const ctx = (exec.context ?? {}) as Record<string, unknown>;
  for (const e of exits) {
    if (e === "RENEWED" && exec.memberId) {
      const n = await tx.membership.count({
        where: { memberId: exec.memberId, activatedAt: { gt: exec.startedAt } },
      });
      if (n) return e;
    }
    if (e === "PAID") {
      if (typeof ctx.invoiceId === "string") {
        const inv = await tx.gymInvoice.findUnique({
          where: { id: ctx.invoiceId },
          select: { status: true },
        });
        if (inv && !["ISSUED", "PARTIALLY_PAID"].includes(inv.status)) return e;
      } else if (exec.memberId) {
        const n = await tx.gymPayment.count({
          where: {
            memberId: exec.memberId,
            status: "SUCCEEDED",
            receivedAt: { gt: exec.startedAt },
          },
        });
        if (n) return e;
      }
    }
    if ((e === "CONTACTED" || e === "LEAD_CLOSED") && exec.leadId) {
      const lead = await tx.lead.findUnique({
        where: { id: exec.leadId },
        select: { lastContactedAt: true, status: true },
      });
      if (
        e === "CONTACTED" &&
        lead?.lastContactedAt &&
        lead.lastContactedAt > exec.startedAt
      )
        return e;
      if (e === "LEAD_CLOSED" && lead && lead.status !== "OPEN") return e;
    }
    if (e === "VISITED" && exec.memberId) {
      const n = await tx.attendanceEvent.count({
        where: {
          memberId: exec.memberId,
          result: "ACCEPTED",
          voidedAt: null,
          occurredAt: { gt: exec.startedAt },
        },
      });
      if (n) return e;
    }
  }
  return null;
}

async function staffWithRoles(
  tx: TenantTransaction,
  roles: string[],
  branchId: string | null,
) {
  // Who to notify (not an access check: approving itself is checked by permission key).
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
    select: { userId: true, user: { select: { email: true } } },
  });
  return rows.map((r) => ({ userId: r.userId, email: r.user.email }));
}

async function subjectName(
  tx: TenantTransaction,
  exec: { memberId: string | null; leadId: string | null },
) {
  if (exec.memberId) {
    const m = await tx.memberProfile.findUnique({
      where: { id: exec.memberId },
      select: { firstName: true, lastName: true },
    });
    return m ? [m.firstName, m.lastName].filter(Boolean).join(" ") : "member";
  }
  if (exec.leadId) {
    const l = await tx.lead.findUnique({
      where: { id: exec.leadId },
      select: { firstName: true, lastName: true },
    });
    return l ? [l.firstName, l.lastName].filter(Boolean).join(" ") : "lead";
  }
  return "someone";
}

const linkFor = (exec: { memberId: string | null; leadId: string | null }) =>
  exec.leadId
    ? `/leads/${exec.leadId}`
    : exec.memberId
      ? `/members/${exec.memberId}`
      : "/automations";

async function performStep(
  tx: TenantTransaction,
  tenantId: string,
  exec: {
    id: string;
    memberId: string | null;
    leadId: string | null;
    context: unknown;
  },
  workflowName: string,
  idx: number,
  step: Exclude<Step, { type: "wait" | "approval" }>,
  now: Date,
): Promise<{ status: "DONE" | "SKIPPED"; result: Record<string, unknown> }> {
  const actor = { system: true as const, tenantId };
  const ctx = (exec.context ?? {}) as Record<string, unknown>;
  const branchId = typeof ctx.branchId === "string" ? ctx.branchId : null;
  const facts = await factsForSubjectTx(tx, tenantId, exec, now);
  switch (step.type) {
    case "send_template": {
      const phone = exec.memberId
        ? (
            await tx.memberProfile.findUnique({
              where: { id: exec.memberId },
              select: { phone: true },
            })
          )?.phone
        : exec.leadId
          ? (
              await tx.lead.findUnique({
                where: { id: exec.leadId },
                select: { phone: true },
              })
            )?.phone
          : null;
      if (!phone) return { status: "SKIPPED", result: { reason: "NO_PHONE" } };
      const q = await queueMessageTx(tx, tenantId, {
        kind: "TEMPLATE",
        templateId: step.templateId,
        values: resolveVariables(step.variables, facts),
        toPhone: phone,
        memberId: exec.memberId,
        leadId: exec.leadId,
        purpose: "AUTOMATION",
        executionId: exec.id,
        idempotencyKey: `auto:${exec.id}:${idx}`,
      });
      return q.queued
        ? { status: "DONE", result: { outboundId: q.id } }
        : { status: "SKIPPED", result: { reason: q.reason } };
    }
    case "create_task": {
      let assignee: string | null = null;
      let taskBranch = branchId;
      if (exec.leadId) {
        const lead = await tx.lead.findUnique({
          where: { id: exec.leadId },
          select: { ownerUserId: true, branchId: true },
        });
        if (step.assignTo === "LEAD_OWNER")
          assignee = lead?.ownerUserId ?? null;
        taskBranch ??= lead?.branchId ?? null;
      } else if (exec.memberId && !taskBranch) {
        taskBranch =
          (
            await tx.memberProfile.findUnique({
              where: { id: exec.memberId },
              select: { homeBranchId: true },
            })
          )?.homeBranchId ?? null;
      }
      if (step.assignTo === "USER" && step.userId) {
        const ok = await tx.tenantMembership.findFirst({
          where: { userId: step.userId, status: "ACTIVE" },
        });
        assignee = ok ? step.userId : null;
      }
      if (!taskBranch)
        return {
          status: "SKIPPED",
          result: { reason: "No branch for the task" },
        };
      const task = await tx.followUpTask.create({
        data: {
          tenantId,
          branchId: taskBranch,
          kind: "FOLLOW_UP",
          title: renderTemplate(step.title, facts).slice(0, 200),
          notes: `Created by automation “${workflowName}”.`,
          dueAt: new Date(now.getTime() + step.dueInHours * 3600_000),
          assigneeUserId: assignee,
          leadId: exec.leadId,
          memberId: exec.memberId,
        },
      });
      return { status: "DONE", result: { taskId: task.id, assignee } };
    }
    case "assign_staff": {
      if (!exec.leadId)
        return { status: "SKIPPED", result: { reason: "Not a lead" } };
      const lead = await tx.lead.findUnique({ where: { id: exec.leadId } });
      if (!lead)
        return { status: "SKIPPED", result: { reason: "Lead not found" } };
      const to =
        step.mode === "ROUND_ROBIN"
          ? await roundRobinOwner(tx, tenantId, lead.branchId)
          : (step.userId ?? null);
      if (!to || to === lead.ownerUserId)
        return {
          status: "SKIPPED",
          result: { reason: to ? "Already theirs" : "Nobody to assign" },
        };
      await reassignTx(tx, actor, tenantId, lead, to, true);
      return { status: "DONE", result: { ownerUserId: to } };
    }
    case "notify":
    case "owner_alert": {
      let recipients: { userId: string; email: string | null }[] = [];
      if (step.type === "owner_alert" || step.to === "OWNERS")
        recipients = await staffWithRoles(tx, ["GYM_OWNER", "GYM_ADMIN"], null);
      else if (step.to === "BRANCH_MANAGERS")
        recipients = await staffWithRoles(tx, ["BRANCH_MANAGER"], branchId);
      else if (exec.leadId) {
        const lead = await tx.lead.findUnique({
          where: { id: exec.leadId },
          select: { ownerUserId: true },
        });
        if (lead?.ownerUserId)
          recipients = [{ userId: lead.ownerUserId, email: null }];
      }
      const name = await subjectName(tx, exec);
      for (const r of recipients)
        await notify(tx, tenantId, {
          templateKey: "automation.alert",
          recipient: {
            userId: r.userId,
            email: step.type === "owner_alert" ? r.email : null,
          },
          channels:
            step.type === "owner_alert" ? ["IN_APP", "EMAIL"] : ["IN_APP"],
          data: {
            workflow: workflowName,
            subject: name,
            message: renderTemplate(step.message, facts),
          },
          link: linkFor(exec),
          dedupeKey: `auto:${exec.id}:${idx}:${r.userId}`,
        });
      return recipients.length
        ? { status: "DONE", result: { notified: recipients.length } }
        : { status: "SKIPPED", result: { reason: "Nobody to notify" } };
    }
    case "update_lead_stage": {
      if (!exec.leadId)
        return { status: "SKIPPED", result: { reason: "Not a lead" } };
      const [lead, stage] = [
        await tx.lead.findUnique({
          where: { id: exec.leadId },
          select: { id: true, stageId: true, branchId: true, status: true },
        }),
        await tx.leadStage.findUnique({ where: { id: step.stageId } }),
      ];
      if (!lead || !stage || stage.archivedAt)
        return { status: "SKIPPED", result: { reason: "Stage not found" } };
      // Won comes only from a paid membership, Lost needs a person's reason (M5 rules).
      if (stage.category === "WON" || stage.category === "LOST")
        return {
          status: "SKIPPED",
          result: { reason: `Can't move to ${stage.category} automatically` },
        };
      if (lead.status !== "OPEN")
        return { status: "SKIPPED", result: { reason: "Lead is closed" } };
      const moved = await moveToStageTx(tx, actor, tenantId, lead, stage, {
        reason: `automation: ${workflowName}`,
      });
      return {
        status: moved ? "DONE" : "SKIPPED",
        result: { stageId: stage.id },
      };
    }
  }
}

async function stepOnce(
  deps: CoreDeps,
  tx: TenantTransaction,
  tenantId: string,
  executionId: string,
): Promise<StepOutcome> {
  const now = nowOf(deps);
  // One runner per execution at a time.
  await tx.$queryRaw`SELECT id FROM app.automation_execution WHERE id = ${executionId}::uuid FOR UPDATE`;
  const exec = await tx.automationExecution.findUnique({
    where: { id: executionId },
    include: { version: true, workflow: true },
  });
  // A WAITING execution re-checks its wait step's own resume time (exec.resumeAt is only the
  // scheduler's next look).
  if (!exec || !["RUNNING", "WAITING"].includes(exec.status)) return "NOOP";
  const finish = async (
    status: "COMPLETED" | "EXITED" | "CANCELLED",
    error?: string,
  ) => {
    await tx.automationExecution.update({
      where: { id: exec.id },
      data: { status, finishedAt: now, resumeAt: null, error: error ?? null },
    });
    return status;
  };
  const ent = await loadEntitlements(tx, tenantId, now);
  if (!isFeatureEnabled(ent, "automation.enabled"))
    return finish("CANCELLED", "The plan no longer includes automation.");
  if (!exec.workflow.enabled || exec.workflow.archivedAt)
    return finish("CANCELLED", "The workflow was turned off.");
  const parsed = workflowDefinitionSchema.safeParse(exec.version.definition);
  if (!parsed.success)
    return finish("CANCELLED", "Invalid workflow definition.");
  const def = parsed.data;
  const idx = exec.nextStep;
  if (idx >= def.steps.length) return finish("COMPLETED");
  const goal = await goalReached(tx, exec, def.exitWhen);
  if (goal) return finish("EXITED", `Goal reached: ${goal.toLowerCase()}`);
  const step = def.steps[idx]!;
  const run = await tx.automationStepRun.findUnique({
    where: {
      tenantId_executionId_stepIndex: {
        tenantId,
        executionId: exec.id,
        stepIndex: idx,
      },
    },
  });
  const advance = async () => {
    await tx.automationExecution.update({
      where: { id: exec.id },
      data: {
        nextStep: idx + 1,
        status: "RUNNING",
        resumeAt: null,
        error: null,
      },
    });
    return "CONTINUE" as const;
  };
  if (step.type === "wait") {
    if (!run) {
      const resumeAt = new Date(now.getTime() + step.hours * 3600_000);
      await tx.automationStepRun.create({
        data: {
          tenantId,
          executionId: exec.id,
          stepIndex: idx,
          type: step.type,
          status: "WAITING",
          result: { resumeAt: resumeAt.toISOString() },
        },
      });
      await tx.automationExecution.update({
        where: { id: exec.id },
        data: { status: "WAITING", resumeAt },
      });
      return "WAITING";
    }
    const resumeAt = new Date(
      String(
        (run.result as { resumeAt?: string } | null)?.resumeAt ??
          now.toISOString(),
      ),
    );
    if (resumeAt > now) {
      await tx.automationExecution.update({
        where: { id: exec.id },
        data: { status: "WAITING", resumeAt },
      });
      return "WAITING";
    }
    await tx.automationStepRun.update({
      where: { id: run.id },
      data: { status: "DONE", finishedAt: now },
    });
    return advance();
  }
  if (step.type === "approval") {
    if (run?.status === "DONE") return advance();
    if (!run) {
      await tx.automationStepRun.create({
        data: {
          tenantId,
          executionId: exec.id,
          stepIndex: idx,
          type: step.type,
          status: "WAITING",
          result: { note: step.note },
        },
      });
      await tx.automationExecution.update({
        where: { id: exec.id },
        data: { status: "AWAITING_APPROVAL" },
      });
      const ctx = (exec.context ?? {}) as Record<string, unknown>;
      const approvers = await staffWithRoles(
        tx,
        ["GYM_OWNER", "GYM_ADMIN", "BRANCH_MANAGER"],
        typeof ctx.branchId === "string" ? ctx.branchId : null,
      );
      const name = await subjectName(tx, exec);
      for (const a of approvers)
        await notify(tx, tenantId, {
          templateKey: "automation.approval",
          recipient: { userId: a.userId },
          channels: ["IN_APP"],
          data: {
            workflow: exec.workflow.name,
            subject: name,
            note: step.note,
          },
          link: "/automations/approvals",
          dedupeKey: `approval:${exec.id}:${idx}:${a.userId}`,
        });
    }
    return "AWAITING_APPROVAL";
  }
  if (run) return advance();
  const outcome = await performStep(
    tx,
    tenantId,
    exec,
    exec.workflow.name,
    idx,
    step,
    now,
  );
  await tx.automationStepRun.create({
    data: {
      tenantId,
      executionId: exec.id,
      stepIndex: idx,
      type: step.type,
      status: outcome.status,
      result: outcome.result as Prisma.InputJsonValue,
      finishedAt: now,
    },
  });
  return advance();
}

/**
 * Worker: runs an execution until it waits, needs approval or ends. A failing step rolls back
 * (no step run is written) and the job retries; on the final attempt the execution is FAILED
 * with the reason, visible on the workflow page.
 */
export async function runExecution(
  deps: CoreDeps,
  tenantId: string,
  executionId: string,
  options: { finalAttempt: boolean },
) {
  let last: StepOutcome = "NOOP";
  try {
    for (let i = 0; i < 40; i++) {
      last = await withTenant(deps.db, tenantId, (tx) =>
        stepOnce(deps, tx, tenantId, executionId),
      );
      if (last !== "CONTINUE") return last;
    }
    return last;
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 500) : "Step failed";
    await withTenant(deps.db, tenantId, async (tx) => {
      const exec = await tx.automationExecution.findUnique({
        where: { id: executionId },
      });
      if (!exec) return;
      if (options.finalAttempt) {
        await tx.automationExecution.update({
          where: { id: exec.id },
          data: { status: "FAILED", error: message, finishedAt: nowOf(deps) },
        });
        await tx.automationStepRun.createMany({
          data: [
            {
              tenantId,
              executionId: exec.id,
              stepIndex: exec.nextStep,
              type: "error",
              status: "FAILED",
              result: { error: message },
            },
          ],
          skipDuplicates: true,
        });
        await recordAudit(
          tx,
          { system: true, tenantId },
          {
            action: "automation.execution_failed",
            entityType: "AutomationExecution",
            entityId: exec.id,
            meta: { error: message },
          },
        );
      } else {
        await tx.automationExecution.update({
          where: { id: exec.id },
          data: { error: message },
        });
      }
    });
    throw err;
  }
}

/** Every minute: waits that are over go back on the queue. */
export async function resumeDueExecutionsTx(
  tx: TenantTransaction,
  tenantId: string,
  now: Date,
) {
  const due = await tx.automationExecution.findMany({
    where: { status: "WAITING", resumeAt: { lte: now } },
    select: { id: true },
    take: 500,
  });
  for (const d of due) {
    // Pushed forward a little so the next tick doesn't queue it again while the job is pending.
    await tx.automationExecution.update({
      where: { id: d.id },
      data: { resumeAt: new Date(now.getTime() + 10 * 60_000) },
    });
    await tx.outbox.create({
      data: {
        tenantId,
        topic: "automation.run",
        payload: { executionId: d.id },
      },
    });
  }
  return due.length;
}
