import type { Prisma, TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
} from "../authz";
import { AppError } from "../errors";
import type { DomainEvent } from "../events";
import { currentAccountTx } from "../messaging/accounts";
import { unmappedVariables } from "../messaging/variables";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { addDays, todayIn } from "../time/dates";
import { parseInput } from "../validation";
import {
  definitionProblems,
  EVENT_TRIGGERS,
  isScanTrigger,
  STEP_LABELS,
  TRIGGER_LABELS,
  workflowDefinitionSchema,
  type Step,
  type WorkflowDefinition,
} from "./definition";
import {
  conditionsHoldTx,
  scanHitsTx,
  subjectForEventTx,
  type Subject,
} from "./engine";
import { WORKFLOW_LIBRARY } from "./library";

export const automationGuard = (
  deps: CoreDeps,
  ctx: AuthContext,
  write = false,
) =>
  guard(deps, ctx, {
    permission: "automations.manage",
    entitlement: "automation.enabled",
    write,
  });

export function describeStep(step: Step): string {
  switch (step.type) {
    case "wait":
      return step.hours % 24 === 0
        ? `Wait ${step.hours / 24} day(s)`
        : `Wait ${step.hours} hour(s)`;
    case "create_task":
      return `Task: “${step.title}”`;
    case "notify":
      return `Notify ${step.to.toLowerCase().replace("_", " ")}`;
    case "approval":
      return `Approval: ${step.note}`;
    default:
      return STEP_LABELS[step.type];
  }
}

/** Template, stage, staff and segment ids in the definition must exist in this gym. */
async function referenceProblems(
  tx: TenantTransaction,
  def: WorkflowDefinition,
  forEnable: boolean,
) {
  const problems = definitionProblems(def);
  for (const [i, s] of def.steps.entries()) {
    if (s.type === "send_template") {
      const t = await tx.messageTemplate.findUnique({
        where: { id: s.templateId },
      });
      if (!t || t.status === "DELETED")
        problems.push(`Step ${i + 1}: template not found.`);
      else {
        if (forEnable && t.status !== "APPROVED")
          problems.push(`Step ${i + 1}: “${t.name}” isn't approved yet.`);
        const missing = unmappedVariables(t.variables, s.variables);
        if (missing.length)
          problems.push(
            `Step ${i + 1}: fill ${missing.map((m) => `{{${m}}}`).join(", ")}.`,
          );
      }
    }
    if (
      s.type === "update_lead_stage" &&
      !(await tx.leadStage.findUnique({ where: { id: s.stageId } }))
    )
      problems.push(`Step ${i + 1}: stage not found.`);
    if (
      (s.type === "create_task" || s.type === "assign_staff") &&
      s.userId &&
      !(await tx.tenantMembership.findFirst({
        where: { userId: s.userId, status: "ACTIVE" },
      }))
    )
      problems.push(`Step ${i + 1}: that staff member isn't active.`);
  }
  for (const c of def.conditions)
    if (
      c.field === "segment" &&
      !(await tx.segment.findUnique({ where: { id: c.value } }))
    )
      problems.push("An audience condition points at a deleted audience.");
  if (
    forEnable &&
    def.steps.some((s) => s.type === "send_template") &&
    !(await currentAccountTx(tx))
  )
    problems.push(
      "Connect WhatsApp before switching on a workflow that sends messages.",
    );
  return problems;
}

export async function listWorkflows(deps: CoreDeps, ctx: AuthContext) {
  await automationGuard(deps, ctx);
  const since = new Date(nowOf(deps).getTime() - 30 * 86_400_000);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.automationWorkflow.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    const versions = await tx.automationWorkflowVersion.findMany({
      where: {
        id: {
          in: rows
            .map((r) => r.currentVersionId)
            .filter((v): v is string => !!v),
        },
      },
    });
    const stats = await tx.automationExecution.groupBy({
      by: ["workflowId", "status"],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
    });
    return rows.map((r) => {
      const v = versions.find((x) => x.id === r.currentVersionId);
      const def = v ? workflowDefinitionSchema.safeParse(v.definition) : null;
      const s = stats.filter((x) => x.workflowId === r.id);
      return {
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        templateKey: r.templateKey,
        version: v?.version ?? 0,
        trigger: def?.success
          ? TRIGGER_LABELS[def.data.trigger.type].replace(
              "N days",
              `${def.data.trigger.days ?? "N"} days`,
            )
          : "—",
        steps: def?.success ? def.data.steps.map(describeStep) : [],
        last30: Object.fromEntries(
          s.map((x) => [x.status, x._count._all]),
        ) as Record<string, number>,
      };
    });
  });
}

export async function getWorkflow(
  deps: CoreDeps,
  ctx: AuthContext,
  workflowId: string,
) {
  await automationGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const wf = await tx.automationWorkflow.findUnique({
      where: { id: workflowId },
    });
    if (!wf || wf.archivedAt)
      throw new AppError("NOT_FOUND", "Workflow not found.");
    const versions = await tx.automationWorkflowVersion.findMany({
      where: { workflowId },
      orderBy: { version: "desc" },
    });
    const current = versions.find((v) => v.id === wf.currentVersionId);
    const definition = current
      ? workflowDefinitionSchema.parse(current.definition)
      : null;
    const executions = await tx.automationExecution.findMany({
      where: { workflowId },
      orderBy: { startedAt: "desc" },
      take: 50,
      include: {
        steps: { orderBy: { stepIndex: "asc" } },
        version: { select: { version: true } },
      },
    });
    const members = await tx.memberProfile.findMany({
      where: {
        id: {
          in: executions.map((e) => e.memberId).filter((v): v is string => !!v),
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    const leads = await tx.lead.findMany({
      where: {
        id: {
          in: executions.map((e) => e.leadId).filter((v): v is string => !!v),
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    const nameOf = (e: { memberId: string | null; leadId: string | null }) => {
      const p =
        members.find((m) => m.id === e.memberId) ??
        leads.find((l) => l.id === e.leadId);
      return p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "—";
    };
    return {
      workflow: wf,
      definition,
      problems: definition
        ? await referenceProblems(tx, definition, true)
        : ["No definition yet."],
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        createdAt: v.createdAt,
        current: v.id === wf.currentVersionId,
      })),
      executions: executions.map((e) => ({
        id: e.id,
        subject: nameOf(e),
        memberId: e.memberId,
        leadId: e.leadId,
        status: e.status,
        version: e.version.version,
        nextStep: e.nextStep,
        resumeAt: e.resumeAt,
        error: e.error,
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        steps: e.steps.map((s) => ({
          index: s.stepIndex,
          type: s.type,
          status: s.status,
          result: s.result,
          at: s.finishedAt ?? s.startedAt,
        })),
      })),
    };
  });
}

const saveSchema = z.object({
  name: z.string().trim().min(2, "Name the workflow.").max(80),
  definition: z.preprocess(
    (v) => (typeof v === "string" ? JSON.parse(v) : v),
    workflowDefinitionSchema,
  ),
});

/** Every save is a new immutable version; running executions keep the version they started on. */
export async function saveWorkflow(
  deps: CoreDeps,
  ctx: AuthContext,
  workflowId: string | null,
  raw: unknown,
) {
  await automationGuard(deps, ctx, true);
  const input = parseInput(saveSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const problems = (
      await referenceProblems(tx, input.definition, false)
    ).filter((p) => !p.startsWith("Connect WhatsApp"));
    if (definitionProblems(input.definition).length)
      throw new AppError(
        "VALIDATION_FAILED",
        definitionProblems(input.definition).join(" "),
      );
    let wf = workflowId
      ? await tx.automationWorkflow.findUnique({ where: { id: workflowId } })
      : null;
    if (workflowId && (!wf || wf.archivedAt))
      throw new AppError("NOT_FOUND", "Workflow not found.");
    wf ??= await tx.automationWorkflow.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.name,
        createdById: ctx.userId,
      },
    });
    const last = await tx.automationWorkflowVersion.aggregate({
      where: { workflowId: wf.id },
      _max: { version: true },
    });
    const version = await tx.automationWorkflowVersion.create({
      data: {
        tenantId: ctx.tenantId,
        workflowId: wf.id,
        version: (last._max.version ?? 0) + 1,
        definition: input.definition as unknown as Prisma.InputJsonValue,
        createdById: ctx.userId,
      },
    });
    // A version that can't run switches the workflow off rather than failing later.
    const enable =
      wf.enabled &&
      (await referenceProblems(tx, input.definition, true)).length === 0;
    await tx.automationWorkflow.update({
      where: { id: wf.id },
      data: { name: input.name, currentVersionId: version.id, enabled: enable },
    });
    await recordAudit(tx, ctx, {
      action: workflowId
        ? "automation.workflow_updated"
        : "automation.workflow_created",
      entityType: "AutomationWorkflow",
      entityId: wf.id,
      after: {
        name: input.name,
        version: version.version,
        definition: input.definition,
      },
    });
    return {
      id: wf.id,
      version: version.version,
      problems,
      disabled: wf.enabled && !enable,
    };
  });
}

export async function setWorkflowEnabled(
  deps: CoreDeps,
  ctx: AuthContext,
  workflowId: string,
  enabled: boolean,
) {
  await automationGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    const wf = await tx.automationWorkflow.findUnique({
      where: { id: workflowId },
    });
    if (!wf || wf.archivedAt || !wf.currentVersionId)
      throw new AppError("NOT_FOUND", "Workflow not found.");
    if (enabled) {
      const v = await tx.automationWorkflowVersion.findUniqueOrThrow({
        where: { id: wf.currentVersionId },
      });
      const problems = await referenceProblems(
        tx,
        workflowDefinitionSchema.parse(v.definition),
        true,
      );
      if (problems.length)
        throw new AppError(
          "VALIDATION_FAILED",
          `Fix this first: ${problems.join(" ")}`,
        );
    }
    await tx.automationWorkflow.update({
      where: { id: wf.id },
      data: { enabled },
    });
    await recordAudit(tx, ctx, {
      action: enabled
        ? "automation.workflow_enabled"
        : "automation.workflow_disabled",
      entityType: "AutomationWorkflow",
      entityId: wf.id,
    });
  });
}

export async function archiveWorkflow(
  deps: CoreDeps,
  ctx: AuthContext,
  workflowId: string,
) {
  await automationGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    await tx.automationWorkflow.update({
      where: { id: workflowId },
      data: { archivedAt: nowOf(deps), enabled: false },
    });
    await recordAudit(tx, ctx, {
      action: "automation.workflow_archived",
      entityType: "AutomationWorkflow",
      entityId: workflowId,
    });
  });
}

export function workflowLibrary() {
  return WORKFLOW_LIBRARY.map((w) => ({
    key: w.key,
    name: w.name,
    description: w.description,
  }));
}

/** Installs a ready-made workflow, switched off, resolving templates by name. */
export async function installLibraryWorkflow(
  deps: CoreDeps,
  ctx: AuthContext,
  key: string,
) {
  await automationGuard(deps, ctx, true);
  const item = WORKFLOW_LIBRARY.find((w) => w.key === key);
  if (!item) throw new AppError("NOT_FOUND", "Unknown ready-made workflow.");
  const { warnings, definition } = await inTenant(deps, ctx, async (tx) => {
    const account = await currentAccountTx(tx);
    const warnings: string[] = [];
    const steps: Step[] = [];
    for (const s of item.steps) {
      if (s.type !== "send_template_by_name") {
        steps.push(s);
        continue;
      }
      const t = account
        ? await tx.messageTemplate.findFirst({
            where: {
              accountId: account.id,
              name: s.templateName,
              status: { not: "DELETED" },
            },
          })
        : null;
      if (!t) {
        warnings.push(
          `No “${s.templateName}” template yet: its send step was left out. Add one in WhatsApp Manager, sync, then add the step.`,
        );
        continue;
      }
      steps.push({
        type: "send_template",
        templateId: t.id,
        variables: s.variables as never,
      });
    }
    while (steps[steps.length - 1]?.type === "wait") steps.pop();
    return {
      warnings,
      definition: {
        trigger: item.trigger,
        conditions: [],
        steps,
        exitWhen: item.exitWhen,
      },
    };
  });
  const saved = await saveWorkflow(deps, ctx, null, {
    name: item.name,
    definition,
  });
  await inTenant(deps, ctx, (tx) =>
    tx.automationWorkflow.update({
      where: { id: saved.id },
      data: { templateKey: item.key },
    }),
  );
  return { id: saved.id, warnings };
}

// --- dry run --------------------------------------------------------------------------------------

/**
 * Who the workflow would have started for over the last 7 days (events that happened, or scan
 * dates that passed), with conditions applied. Nothing is written or sent.
 */
export async function dryRunWorkflow(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await automationGuard(deps, ctx);
  const def = parseInput(
    z.preprocess(
      (v) => (typeof v === "string" ? JSON.parse(v) : v),
      workflowDefinitionSchema,
    ),
    raw,
  );
  const now = nowOf(deps);
  const today = todayIn(ctx.timezone, now);
  return inTenant(deps, ctx, async (tx) => {
    const candidates: { name: string; when: string; subject: Subject }[] = [];
    if (isScanTrigger(def.trigger.type)) {
      for (const hit of await scanHitsTx(
        tx,
        def.trigger.type,
        def.trigger.days ?? 0,
        addDays(today, -6),
        today,
      ))
        candidates.push({
          name: hit.name,
          when: hit.triggerDate,
          subject: hit.subject,
        });
    } else if (
      (EVENT_TRIGGERS as readonly string[]).includes(def.trigger.type)
    ) {
      const rows = await tx.outbox.findMany({
        where: {
          topic: "event",
          createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
          payload: { path: ["type"], equals: def.trigger.type },
        },
        orderBy: { createdAt: "desc" },
        take: 1000,
      });
      for (const r of rows) {
        const event = r.payload as unknown as DomainEvent;
        const subject = await subjectForEventTx(tx, event);
        if (!subject) continue;
        if (
          def.trigger.type === "retention.flagged" &&
          def.trigger.retentionKinds?.length &&
          !def.trigger.retentionKinds.includes(
            (event.data as { kind?: string }).kind as never,
          )
        )
          continue;
        const name = subject.memberId
          ? await tx.memberProfile.findUnique({
              where: { id: subject.memberId },
              select: { firstName: true, lastName: true },
            })
          : subject.leadId
            ? await tx.lead.findUnique({
                where: { id: subject.leadId },
                select: { firstName: true, lastName: true },
              })
            : null;
        candidates.push({
          name: name
            ? [name.firstName, name.lastName].filter(Boolean).join(" ")
            : "—",
          when: r.createdAt.toISOString(),
          subject,
        });
      }
    }
    const rows = [];
    for (const c of candidates)
      rows.push({
        name: c.name,
        when: c.when,
        branchId: c.subject.branchId,
        passes: await conditionsHoldTx(tx, def, c.subject, now, ctx.timezone),
      });
    return {
      triggered: rows.length,
      wouldStart: rows.filter((r) => r.passes).length,
      rows: rows.slice(0, 100),
      steps: def.steps.map(describeStep),
    };
  });
}

// --- approvals -----------------------------------------------------------------------------------

export async function listApprovals(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, {
    permission: "automations.approve",
    entitlement: "automation.enabled",
  });
  const allowed = allowedBranchIds(ctx, "automations.approve");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.automationExecution.findMany({
      where: { status: "AWAITING_APPROVAL" },
      orderBy: { startedAt: "asc" },
      take: 200,
      include: {
        workflow: { select: { name: true } },
        steps: { where: { status: "WAITING", type: "approval" } },
      },
    });
    const visible = rows.filter((r) => {
      const branchId =
        (r.context as { branchId?: string } | null)?.branchId ?? null;
      return (
        allowed === "ALL" || (branchId !== null && allowed.includes(branchId))
      );
    });
    const members = await tx.memberProfile.findMany({
      where: {
        id: {
          in: visible.map((e) => e.memberId).filter((v): v is string => !!v),
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    const leads = await tx.lead.findMany({
      where: {
        id: {
          in: visible.map((e) => e.leadId).filter((v): v is string => !!v),
        },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    return visible.map((r) => {
      const p =
        members.find((m) => m.id === r.memberId) ??
        leads.find((l) => l.id === r.leadId);
      return {
        id: r.id,
        workflow: r.workflow.name,
        subject: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "—",
        memberId: r.memberId,
        leadId: r.leadId,
        note: (r.steps[0]?.result as { note?: string } | null)?.note ?? "",
        since: r.steps[0]?.startedAt ?? r.startedAt,
      };
    });
  });
}

/** Approve continues the execution; reject cancels it. Branch-scoped permission. */
export async function decideApproval(
  deps: CoreDeps,
  ctx: AuthContext,
  executionId: string,
  raw: unknown,
) {
  await guard(deps, ctx, {
    permission: "automations.approve",
    entitlement: "automation.enabled",
    write: true,
  });
  const input = parseInput(
    z.object({
      approve: z.boolean(),
      note: z.string().trim().max(300).optional(),
    }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM app.automation_execution WHERE id = ${executionId}::uuid FOR UPDATE`;
    const exec = await tx.automationExecution.findUnique({
      where: { id: executionId },
    });
    if (!exec) throw new AppError("NOT_FOUND", "Not found.");
    const branchId =
      (exec.context as { branchId?: string } | null)?.branchId ?? null;
    requirePermission(ctx, "automations.approve", { branchId });
    if (exec.status !== "AWAITING_APPROVAL")
      throw new AppError("CONFLICT", "This no longer needs approval.");
    const run = await tx.automationStepRun.findUnique({
      where: {
        tenantId_executionId_stepIndex: {
          tenantId: ctx.tenantId,
          executionId,
          stepIndex: exec.nextStep,
        },
      },
    });
    if (!run || run.type !== "approval" || run.status !== "WAITING")
      throw new AppError("CONFLICT", "This no longer needs approval.");
    const now = nowOf(deps);
    await tx.automationStepRun.update({
      where: { id: run.id },
      data: {
        status: input.approve ? "DONE" : "SKIPPED",
        approvedById: ctx.userId,
        approvedAt: now,
        finishedAt: now,
        result: {
          ...((run.result as object | null) ?? {}),
          decision: input.approve ? "APPROVED" : "REJECTED",
          note: input.note ?? null,
        },
      },
    });
    if (input.approve) {
      await tx.automationExecution.update({
        where: { id: exec.id },
        data: { status: "RUNNING", nextStep: exec.nextStep + 1 },
      });
      await tx.outbox.create({
        data: {
          tenantId: ctx.tenantId,
          topic: "automation.run",
          payload: { executionId: exec.id },
        },
      });
    } else {
      await tx.automationExecution.update({
        where: { id: exec.id },
        data: {
          status: "CANCELLED",
          finishedAt: now,
          error: `Rejected${input.note ? `: ${input.note}` : ""}`,
        },
      });
    }
    await recordAudit(tx, ctx, {
      action: input.approve
        ? "automation.step_approved"
        : "automation.step_rejected",
      entityType: "AutomationExecution",
      entityId: exec.id,
      branchId,
      meta: { note: input.note ?? null },
    });
  });
}

export async function cancelExecution(
  deps: CoreDeps,
  ctx: AuthContext,
  executionId: string,
) {
  await automationGuard(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    const exec = await tx.automationExecution.findUnique({
      where: { id: executionId },
    });
    if (
      !exec ||
      !["RUNNING", "WAITING", "AWAITING_APPROVAL"].includes(exec.status)
    )
      throw new AppError("CONFLICT", "Nothing to stop.");
    await tx.automationExecution.update({
      where: { id: exec.id },
      data: {
        status: "CANCELLED",
        finishedAt: nowOf(deps),
        error: "Stopped by staff",
      },
    });
    await tx.outboundMessage.updateMany({
      where: { executionId: exec.id, status: "QUEUED" },
      data: { status: "SKIPPED", skipReason: "Automation stopped" },
    });
    await recordAudit(tx, ctx, {
      action: "automation.execution_cancelled",
      entityType: "AutomationExecution",
      entityId: exec.id,
    });
  });
}

/** What the workflow editor can refer to: approved templates, lead stages, active staff. */
export async function automationEditorOptions(
  deps: CoreDeps,
  ctx: AuthContext,
) {
  await automationGuard(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const account = await currentAccountTx(tx);
    const templates = account
      ? await tx.messageTemplate.findMany({
          where: { accountId: account.id, status: "APPROVED" },
          select: { id: true, name: true, category: true, variables: true },
          orderBy: { name: "asc" },
        })
      : [];
    const stages = await tx.leadStage.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { position: "asc" },
    });
    const staff = await tx.tenantMembership.findMany({
      where: {
        status: "ACTIVE",
        roles: { some: { roleKey: { not: "MEMBER" } } },
      },
      select: { userId: true, user: { select: { name: true } } },
    });
    return {
      templates,
      stages,
      staff: staff.map((s) => ({ userId: s.userId, name: s.user.name })),
    };
  });
}
