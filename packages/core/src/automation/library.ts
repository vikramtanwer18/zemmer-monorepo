import type { ExitWhen, Step, WorkflowDefinition } from "./definition";

/**
 * Ready-made workflows (M6 §5). Send steps name the WhatsApp template they expect; installing
 * resolves it among the gym's synced templates. If the gym has no such template, the send step
 * is left out and the installer says so (the workflow is installed switched off either way).
 */
type LibraryStep =
  | Step
  | {
      type: "send_template_by_name";
      templateName: string;
      variables: Record<string, { source: string } | { text: string }>;
    };

export type LibraryWorkflow = {
  key: string;
  name: string;
  description: string;
  trigger: WorkflowDefinition["trigger"];
  steps: LibraryStep[];
  exitWhen: ExitWhen[];
};

export const WORKFLOW_LIBRARY: LibraryWorkflow[] = [
  {
    key: "expiry_reminders",
    name: "Expiry reminder sequence",
    description:
      "7 days before a membership ends: WhatsApp reminder, another 3 days before, then a call task. Stops as soon as they renew.",
    trigger: { type: "membership.expiring", days: 7 },
    steps: [
      {
        type: "send_template_by_name",
        templateName: "membership_renewal_reminder",
        variables: {
          "1": { source: "first_name" },
          "2": { source: "plan_name" },
          "3": { source: "end_date" },
        },
      },
      { type: "wait", hours: 96 },
      {
        type: "send_template_by_name",
        templateName: "membership_renewal_reminder",
        variables: {
          "1": { source: "first_name" },
          "2": { source: "plan_name" },
          "3": { source: "end_date" },
        },
      },
      { type: "wait", hours: 48 },
      {
        type: "create_task",
        title:
          "Call {{first_name}} about renewing ({{plan_name}} ends {{end_date}})",
        dueInHours: 24,
        assignTo: "UNASSIGNED",
      },
    ],
    exitWhen: ["RENEWED"],
  },
  {
    key: "overdue_follow_up",
    name: "Overdue payment follow-up",
    description:
      "3 days after an invoice is due: payment reminder, a collection task 4 days later, and an owner alert after another 3. Stops when it's paid.",
    trigger: { type: "payment.overdue", days: 3 },
    steps: [
      {
        type: "send_template_by_name",
        templateName: "payment_due_reminder",
        variables: {
          "1": { source: "first_name" },
          "2": { source: "amount_due" },
          "3": { source: "gym_name" },
          "4": { text: "the member app or the front desk" },
        },
      },
      { type: "wait", hours: 96 },
      {
        type: "create_task",
        title: "Collect {{amount_due}} from {{first_name}}",
        dueInHours: 24,
        assignTo: "UNASSIGNED",
      },
      { type: "wait", hours: 72 },
      {
        type: "owner_alert",
        message:
          "{{full_name}} still owes {{amount_due}} after reminders and a follow-up task.",
      },
    ],
    exitWhen: ["PAID"],
  },
  {
    key: "speed_to_lead",
    name: "New lead speed-to-lead",
    description:
      "A new lead pings its owner at once; if nobody has contacted them within an hour, the owners are alerted.",
    trigger: { type: "lead.created" },
    steps: [
      {
        type: "notify",
        to: "LEAD_OWNER",
        message: "New lead {{full_name}}: call within 15 minutes.",
      },
      { type: "wait", hours: 1 },
      {
        type: "owner_alert",
        message:
          "{{full_name}} enquired an hour ago and hasn't been contacted yet.",
      },
    ],
    exitWhen: ["CONTACTED", "LEAD_CLOSED"],
  },
  {
    key: "trial_no_show",
    name: "Trial no-show rescue",
    description:
      "When a trial is missed: a call task for the lead's owner within 2 hours, then a we-miss-you WhatsApp next day (needs marketing consent).",
    trigger: { type: "trial.no_show" },
    steps: [
      {
        type: "create_task",
        title: "Call {{first_name}}: missed the trial, offer a new slot",
        dueInHours: 2,
        assignTo: "LEAD_OWNER",
      },
      { type: "wait", hours: 24 },
      {
        type: "send_template_by_name",
        templateName: "we_miss_you",
        variables: {
          "1": { source: "first_name" },
          "2": { source: "gym_name" },
        },
      },
    ],
    exitWhen: ["LEAD_CLOSED"],
  },
  {
    key: "win_back_30",
    name: "Win-back 30 days after expiry",
    description:
      "30 days after a membership ended without renewal: a manager approves, then a we-miss-you WhatsApp (marketing consent needed) and a call task a week later.",
    trigger: { type: "membership.expired", days: 30 },
    steps: [
      { type: "approval", note: "Send the win-back message?" },
      {
        type: "send_template_by_name",
        templateName: "we_miss_you",
        variables: {
          "1": { source: "first_name" },
          "2": { source: "gym_name" },
        },
      },
      { type: "wait", hours: 168 },
      {
        type: "create_task",
        title: "Call {{first_name}} with a comeback offer",
        dueInHours: 48,
        assignTo: "UNASSIGNED",
      },
    ],
    exitWhen: ["RENEWED"],
  },
];
