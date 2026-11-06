import { z } from "zod";
import { variableMapSchema } from "../messaging/variables";

/**
 * Automation workflows (M6 §5): predefined triggers, typed conditions and a fixed list of
 * step types. Stored as validated JSON in an immutable version; no user code ever runs.
 */

export const EVENT_TRIGGERS = [
  "lead.created",
  "lead.uncontacted_sla_breached",
  "trial.booked",
  "trial.attended",
  "trial.no_show",
  "lead.converted",
  "membership.activated",
  "class.booking_cancelled",
  "retention.flagged",
  /** Emitted by M7 (referrals). Accepted now so workflows can be prepared. */
  "referral.converted",
] as const;

/** Found by the daily scan, "N days" from the trigger date. */
export const SCAN_TRIGGERS = [
  "membership.expiring",
  "membership.expired",
  "payment.overdue",
] as const;

export type EventTrigger = (typeof EVENT_TRIGGERS)[number];
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];
export type TriggerType = EventTrigger | ScanTrigger;

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  "lead.created": "A lead is created",
  "lead.uncontacted_sla_breached": "A lead isn't contacted in time",
  "trial.booked": "A trial is booked",
  "trial.attended": "A trial is attended",
  "trial.no_show": "A trial is missed (no-show)",
  "lead.converted": "A lead buys a membership",
  "membership.activated": "A membership starts (purchase or renewal)",
  "class.booking_cancelled": "A class booking is cancelled",
  "retention.flagged": "A member is flagged at risk",
  "referral.converted": "A referral joins (from M7)",
  "membership.expiring": "N days before a membership ends",
  "membership.expired": "N days after a membership ended (not renewed)",
  "payment.overdue": "An invoice is N days overdue",
};

export function isScanTrigger(t: string): t is ScanTrigger {
  return (SCAN_TRIGGERS as readonly string[]).includes(t);
}

export const triggerSchema = z
  .object({
    type: z.enum([...EVENT_TRIGGERS, ...SCAN_TRIGGERS]),
    days: z.number().int().min(0).max(365).optional(),
    /** retention.flagged only: which rule kinds. */
    retentionKinds: z
      .array(
        z.enum([
          "NO_VISIT",
          "VISIT_DROP",
          "EXPIRING",
          "OVERDUE",
          "UNUSED_CREDITS",
          "TRIAL_FOLLOW_UP",
        ]),
      )
      .max(6)
      .optional(),
  })
  .refine((t) => !isScanTrigger(t.type) || t.days !== undefined, {
    path: ["days"],
    message: "Say how many days.",
  });

const ids = z.array(z.uuid()).min(1).max(50);

export const conditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("branch"), op: z.literal("in"), value: ids }),
  z.object({ field: z.literal("plan"), op: z.literal("in"), value: ids }),
  z.object({
    field: z.literal("amountMinor"),
    op: z.enum(["gte", "lte"]),
    value: z.number().int().min(0).max(10_000_000_00),
  }),
  z.object({ field: z.literal("leadSource"), op: z.literal("in"), value: ids }),
  /** The member/lead is (currently) in this saved segment. */
  z.object({
    field: z.literal("segment"),
    op: z.literal("in"),
    value: z.uuid(),
  }),
]);
export type Condition = z.infer<typeof conditionSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

export const stepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wait"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
  }),
  z.object({
    type: z.literal("send_template"),
    templateId: z.uuid(),
    variables: variableMapSchema.default({}),
  }),
  z.object({
    type: z.literal("create_task"),
    title: text(120),
    dueInHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30)
      .default(24),
    assignTo: z
      .enum(["LEAD_OWNER", "UNASSIGNED", "USER"])
      .default("LEAD_OWNER"),
    userId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("assign_staff"),
    mode: z.enum(["ROUND_ROBIN", "USER"]),
    userId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("notify"),
    to: z.enum(["LEAD_OWNER", "BRANCH_MANAGERS", "OWNERS"]),
    message: text(300),
  }),
  z.object({ type: z.literal("owner_alert"), message: text(300) }),
  z.object({ type: z.literal("update_lead_stage"), stageId: z.uuid() }),
  z.object({ type: z.literal("approval"), note: text(200) }),
]);
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step["type"];

export const STEP_LABELS: Record<StepType, string> = {
  wait: "Wait",
  send_template: "Send WhatsApp template",
  create_task: "Create follow-up task",
  assign_staff: "Assign to staff",
  notify: "Notify staff (in-app)",
  owner_alert: "Alert the owners",
  update_lead_stage: "Move lead to a stage",
  approval: "Ask a person to approve",
};

/** Stop the sequence early once the goal is reached (checked before every step). */
export const EXIT_WHEN = [
  "RENEWED",
  "PAID",
  "CONTACTED",
  "LEAD_CLOSED",
  "VISITED",
] as const;
export type ExitWhen = (typeof EXIT_WHEN)[number];

export const workflowDefinitionSchema = z
  .object({
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(10).default([]),
    steps: z.array(stepSchema).min(1, "Add at least one step.").max(12),
    exitWhen: z.array(z.enum(EXIT_WHEN)).max(5).default([]),
  })
  .superRefine((d, ctx) => {
    d.steps.forEach((s, i) => {
      if (
        (s.type === "create_task" && s.assignTo === "USER" && !s.userId) ||
        (s.type === "assign_staff" && s.mode === "USER" && !s.userId)
      )
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "userId"],
          message: "Pick the staff member.",
        });
    });
    if (d.steps[d.steps.length - 1]?.type === "wait")
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "A workflow can't end with a wait.",
      });
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** What the trigger is about. Lead triggers have a lead; the rest a member. */
export function subjectOf(trigger: TriggerType): "LEAD" | "MEMBER" {
  return trigger.startsWith("lead.") || trigger.startsWith("trial.")
    ? "LEAD"
    : "MEMBER";
}

/** Steps that only make sense for leads. */
export const LEAD_ONLY_STEPS: StepType[] = [
  "assign_staff",
  "update_lead_stage",
];

export function definitionProblems(d: WorkflowDefinition): string[] {
  const problems: string[] = [];
  const subject = subjectOf(d.trigger.type);
  if (subject === "MEMBER")
    d.steps.forEach((s, i) => {
      if (LEAD_ONLY_STEPS.includes(s.type))
        problems.push(
          `Step ${i + 1} (${STEP_LABELS[s.type]}) needs a lead trigger.`,
        );
    });
  if (
    subject === "MEMBER" &&
    d.conditions.some((c) => c.field === "leadSource")
  )
    problems.push("“Lead source” conditions need a lead trigger.");
  if (
    subject === "LEAD" &&
    d.exitWhen.some((e) => e === "RENEWED" || e === "VISITED")
  )
    problems.push("“Renewed”/“visited” exits need a member trigger.");
  return problems;
}

/** Facts about the trigger's subject the conditions can test. */
export type ConditionFacts = {
  branchId: string | null;
  planId: string | null;
  amountMinor: number | null;
  leadSourceId: string | null;
  /** Saved segments the subject is in (only those referenced are computed). */
  segments: ReadonlySet<string>;
};

/** All conditions must hold. An unknown fact (null) never satisfies a condition. */
export function evaluateConditions(
  conditions: readonly Condition[],
  f: ConditionFacts,
): boolean {
  return conditions.every((c) => {
    switch (c.field) {
      case "branch":
        return !!f.branchId && c.value.includes(f.branchId);
      case "plan":
        return !!f.planId && c.value.includes(f.planId);
      case "leadSource":
        return !!f.leadSourceId && c.value.includes(f.leadSourceId);
      case "amountMinor":
        return (
          f.amountMinor !== null &&
          (c.op === "gte" ? f.amountMinor >= c.value : f.amountMinor <= c.value)
        );
      case "segment":
        return f.segments.has(c.value);
    }
  });
}

/** Trigger key for a scan hit: the same subject on the same offset never runs twice. */
export function scanTriggerKey(
  type: ScanTrigger,
  refId: string,
  days: number,
): string {
  return `${type}:${refId}:${days}`;
}
