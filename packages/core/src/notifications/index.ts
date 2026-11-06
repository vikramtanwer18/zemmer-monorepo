import { randomUUID } from "node:crypto";
import type { PrismaClient, TenantTransaction } from "@gym/db";
import { inOrder, withTenant } from "@gym/db";
import { AppError } from "../errors";
import { queueMessageTx } from "../messaging/send";

/**
 * Notifications foundation (M2 §7): in-app rows + email through the outbox → worker.
 * SERVICE messages always go (except where the user turned an optional one off);
 * MARKETING needs a recorded marketing consent for the channel (CLAUDE.md: messaging rules).
 */
export type TemplateKey =
  | "member.app_invite"
  | "membership.activated"
  | "invoice.issued"
  | "payment.received"
  | "membership.expiring"
  | "membership.expired"
  | "member.join_requested"
  | "class.reminder"
  | "class.cancelled"
  | "class.promoted"
  | "pt.booked"
  | "pt.cancelled"
  | "payment.link"
  | "invoice.overdue"
  | "refund.processed"
  | "member.data_request"
  | "lead.new"
  | "lead.assigned"
  | "lead.sla_breached"
  | "task.reminder"
  | "task.assigned"
  | "trial.booked"
  | "automation.alert"
  | "automation.approval"
  | "fitness.plan_assigned"
  | "fitness.feedback"
  | "engagement.announcement"
  | "engagement.achievement"
  | "rewards.perk_update";

type TemplateDef = {
  category: "SERVICE" | "MARKETING";
  /** Required messages can't be switched off in preferences. */
  required: boolean;
  title: string;
  subject: string;
  body: string;
};

/** Built-in templates. `{{name}}` placeholders; tenants can override subject/body (EmailTemplate). */
export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  "member.app_invite": {
    category: "SERVICE",
    required: true,
    title: "Your {{gym}} app is ready",
    subject: "Set up your {{gym}} member app",
    body: "Hi {{name}},\n\n{{gym}} has invited you to the member app. Set your password here: {{link}}\n\nThe link expires in 7 days.",
  },
  "membership.activated": {
    category: "SERVICE",
    required: false,
    title: "{{plan}} is active",
    subject: "Your {{plan}} membership is active",
    body: "Hi {{name}},\n\nYour {{plan}} membership at {{gym}} is active from {{start}} to {{end}}.",
  },
  "invoice.issued": {
    category: "SERVICE",
    required: true,
    title: "Invoice {{number}}",
    subject: "{{documentTitle}} {{number}} from {{gym}}",
    body: "Hi {{name}},\n\n{{gym}} has issued {{documentTitle}} {{number}} for {{total}}. Amount due: {{due}}.",
  },
  "payment.received": {
    category: "SERVICE",
    required: true,
    title: "Payment received: {{amount}}",
    subject: "Receipt {{receipt}}: {{amount}} received",
    body: "Hi {{name}},\n\n{{gym}} received {{amount}} by {{method}} on {{date}}. Receipt {{receipt}}.",
  },
  "membership.expiring": {
    category: "SERVICE",
    required: false,
    title: "{{plan}} ends in {{days}} day(s)",
    subject: "Your {{plan}} membership ends on {{end}}",
    body: "Hi {{name}},\n\nYour {{plan}} membership at {{gym}} ends on {{end}}. Renew at the front desk or in the app to keep your access.",
  },
  "membership.expired": {
    category: "SERVICE",
    required: false,
    title: "{{plan}} has ended",
    subject: "Your {{plan}} membership has ended",
    body: "Hi {{name}},\n\nYour {{plan}} membership at {{gym}} ended on {{end}}. We'd love to see you back.",
  },
  "member.join_requested": {
    category: "SERVICE",
    required: false,
    title: "{{name}} asked to join",
    subject: "{{name}} asked to join {{gym}}",
    body: "{{name}} signed up through your join link and is waiting for approval.",
  },
  // --- M3
  "class.reminder": {
    category: "SERVICE",
    required: false,
    title: "{{class}} at {{time}}",
    subject: "Reminder: {{class}} at {{time}}",
    body: "Hi {{name}},\n\nSee you at {{class}} on {{date}} at {{time}} ({{branch}}). Can't make it? Cancel in the app before {{cutoff}} so someone else can take your spot.",
  },
  "class.cancelled": {
    category: "SERVICE",
    required: true,
    title: "{{class}} on {{date}} is cancelled",
    subject: "Cancelled: {{class}} on {{date}} at {{time}}",
    body: "Hi {{name}},\n\n{{gym}} has cancelled {{class}} on {{date}} at {{time}}. {{reason}} Your booking is cancelled and any class credit has been returned.",
  },
  "class.promoted": {
    category: "SERVICE",
    required: true,
    title: "You're in: {{class}} on {{date}}",
    subject: "A spot opened up: you're booked for {{class}}",
    body: "Hi {{name}},\n\nA spot opened up and you've been moved from the waitlist into {{class}} on {{date}} at {{time}}. Can't make it? Cancel in the app before {{cutoff}}.",
  },
  "pt.booked": {
    category: "SERVICE",
    required: false,
    title: "PT session on {{date}} at {{time}}",
    subject: "Personal training booked: {{date}} at {{time}}",
    body: "Hi {{name}},\n\nYour personal training session with {{trainer}} is booked for {{date}} at {{time}} ({{branch}}).",
  },
  "pt.cancelled": {
    category: "SERVICE",
    required: true,
    title: "PT session on {{date}} cancelled",
    subject: "Personal training cancelled: {{date}} at {{time}}",
    body: "Hi {{name}},\n\nYour personal training session with {{trainer}} on {{date}} at {{time}} has been cancelled. {{reason}}",
  },
  // --- M4
  "payment.link": {
    category: "SERVICE",
    required: true,
    title: "Pay {{amount}} online",
    subject: "{{gym}}: pay {{amount}} online",
    body: "Hi {{name}},\n\n{{gym}} has sent you a secure payment link for {{amount}} ({{what}}). Pay here: {{url}}\n\nThe link works until {{expires}}.",
  },
  "invoice.overdue": {
    category: "SERVICE",
    required: false,
    title: "{{amount}} is overdue",
    subject: "{{gym}}: {{amount}} is overdue",
    body: "Hi {{name}},\n\nYou have {{amount}} due at {{gym}} ({{days}} day(s) overdue). You can pay in the app or at the front desk.",
  },
  "refund.processed": {
    category: "SERVICE",
    required: true,
    title: "Refund of {{amount}}",
    subject: "{{gym}}: your refund of {{amount}}",
    body: "Hi {{name}},\n\n{{gym}} has refunded {{amount}} {{how}}. {{when}}",
  },
  "member.data_request": {
    category: "SERVICE",
    required: false,
    title: "{{name}} asked to {{what}}",
    subject: "{{name}} asked to {{what}}",
    body: "{{name}} asked to {{what}} in the member app. Handle it on the Privacy requests page.",
  },
  // --- M5: CRM (staff alerts are in-app; the trial confirmation goes to the person who asked)
  "lead.new": {
    category: "SERVICE",
    required: false,
    title: "New lead: {{lead}}",
    subject: "New lead: {{lead}}",
    body: "{{lead}} enquired via {{via}}. First contact is due by {{due}}.",
  },
  "lead.assigned": {
    category: "SERVICE",
    required: false,
    title: "Lead given to you: {{lead}}",
    subject: "Lead given to you: {{lead}}",
    body: "{{lead}} is now yours to follow up.",
  },
  "lead.sla_breached": {
    category: "SERVICE",
    required: false,
    title: "Not contacted yet: {{lead}}",
    subject: "Lead not contacted within {{minutes}} minutes: {{lead}}",
    body: "{{lead}} came in {{minutes}}+ minutes ago and nobody has contacted them yet.",
  },
  "task.reminder": {
    category: "SERVICE",
    required: false,
    title: "Due {{due}}: {{task}}",
    subject: "Reminder: {{task}} (due {{due}})",
    body: 'Your task "{{task}}" is due {{due}}.',
  },
  "task.assigned": {
    category: "SERVICE",
    required: false,
    title: "New task: {{task}}",
    subject: "New task: {{task}}",
    body: '{{by}} gave you a task: "{{task}}", due {{due}}.',
  },
  "trial.booked": {
    category: "SERVICE",
    required: true,
    title: "Your trial at {{gym}}",
    subject: "Your free trial at {{gym}}: {{when}}",
    body: "Hi {{name}},\n\nYour trial at {{gym}} ({{branch}}) is booked for {{when}}.\n\nShow this pass at the front desk: {{link}}\n\nSee you there!",
  },
  // --- M6: automation (staff)
  "automation.alert": {
    category: "SERVICE",
    required: false,
    title: "{{workflow}}: {{subject}}",
    subject: "{{workflow}}: {{subject}}",
    body: "{{message}}",
  },
  "automation.approval": {
    category: "SERVICE",
    required: false,
    title: "Approve: {{workflow}} for {{subject}}",
    subject: "Approval needed: {{workflow}} for {{subject}}",
    body: "{{note}} Open Automations → Approvals to approve or reject.",
  },
  // --- M7: fitness and engagement (member app, in-app by default)
  "fitness.plan_assigned": {
    category: "SERVICE",
    required: false,
    title: "New workout plan: {{plan}}",
    subject: "{{trainer}} set up your workout plan: {{plan}}",
    body: "Hi {{name}},\n\nYour workout plan “{{plan}}” is ready in the app. Open Workouts to see today's session.",
  },
  "fitness.feedback": {
    category: "SERVICE",
    required: false,
    title: "{{trainer}} left you feedback",
    subject: "{{trainer}} left you feedback",
    body: "{{preview}}",
  },
  "engagement.announcement": {
    category: "SERVICE",
    required: false,
    title: "{{title}}",
    subject: "{{gym}}: {{title}}",
    body: "{{body}}",
  },
  "engagement.achievement": {
    category: "SERVICE",
    required: false,
    title: "Milestone: {{achievement}}",
    subject: "You reached a milestone: {{achievement}}",
    body: "{{description}} {{points}}",
  },
  "rewards.perk_update": {
    category: "SERVICE",
    required: false,
    title: "{{perk}}: {{status}}",
    subject: "Your reward {{perk}}: {{status}}",
    body: "{{note}}",
  },
};

export function isTemplateKey(key: string): key is TemplateKey {
  return key in TEMPLATES;
}

/** Fills `{{var}}` placeholders; unknown placeholders become empty. Plain text only. */
export function renderTemplate(
  text: string,
  data: Record<string, string | number | null | undefined>,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const value = data[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export type Recipient = {
  memberId?: string | null;
  userId?: string | null;
  email?: string | null;
  /** M6: for WhatsApp. Looked up from the member when not given. E.164. */
  phone?: string | null;
  leadId?: string | null;
};

/**
 * M6: messages that may also go on WhatsApp, each through an approved UTILITY template the gym
 * maps in settings (TenantSettings.whatsappNotificationTemplates). Service messages only.
 */
export const WHATSAPP_NOTIFICATION_KEYS = [
  "payment.link",
  "invoice.overdue",
  "membership.expiring",
  "membership.expired",
  "membership.activated",
  "payment.received",
  "class.reminder",
  "trial.booked",
] as const satisfies readonly TemplateKey[];
export type WhatsAppNotificationKey =
  (typeof WHATSAPP_NOTIFICATION_KEYS)[number];

/** Placeholders a built-in message fills ({{name}}, {{amount}}, …): what a template can map to. */
export function notificationDataKeys(key: TemplateKey): string[] {
  const t = TEMPLATES[key];
  const found = [
    ...`${t.title} ${t.subject} ${t.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g),
  ].map((m) => m[1]!);
  return [...new Set(found)];
}

export type WhatsAppNotificationMapping = {
  templateId: string;
  /** template placeholder → notification data key */
  variables: Record<string, string>;
};

async function queueWhatsAppNotification(
  tx: TenantTransaction,
  tenantId: string,
  input: NotifyInput,
  fallbackKey: string,
): Promise<"QUEUED" | "NONE"> {
  if (
    !(WHATSAPP_NOTIFICATION_KEYS as readonly string[]).includes(
      input.templateKey,
    )
  )
    return "NONE";
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { whatsappNotificationTemplates: true },
  });
  const map = (settings?.whatsappNotificationTemplates ?? {}) as Record<
    string,
    WhatsAppNotificationMapping | undefined
  >;
  const mapping = map[input.templateKey];
  if (!mapping) return "NONE";
  let phone = input.recipient.phone ?? null;
  if (!phone && input.recipient.memberId) {
    const m = await tx.memberProfile.findUnique({
      where: { id: input.recipient.memberId },
      select: { phone: true },
    });
    phone = m?.phone ?? null;
  }
  if (!phone) return "NONE";
  const values: Record<string, string> = {};
  for (const [placeholder, dataKey] of Object.entries(mapping.variables))
    values[placeholder] = String(input.data[dataKey] ?? "");
  const result = await queueMessageTx(tx, tenantId, {
    kind: "TEMPLATE",
    templateId: mapping.templateId,
    values,
    toPhone: phone,
    memberId: input.recipient.memberId ?? null,
    leadId: input.recipient.leadId ?? null,
    purpose: "NOTIFICATION",
    idempotencyKey: `notif:${input.templateKey}:${input.dedupeKey ?? fallbackKey}`,
  });
  return result.queued ? "QUEUED" : "NONE";
}

export type NotifyInput = {
  templateKey: TemplateKey;
  recipient: Recipient;
  data: Record<string, string | number | null | undefined>;
  link?: string | null;
  /** Makes the send idempotent per channel, e.g. "expiring:<membershipId>:7". */
  dedupeKey?: string;
  /** Default: in-app, email and (M6) WhatsApp when a template is mapped for this message. */
  channels?: ("IN_APP" | "EMAIL" | "WHATSAPP")[];
};

async function hasMarketingConsent(
  tx: TenantTransaction,
  memberId: string,
  channel: "EMAIL",
): Promise<boolean> {
  const latest = await tx.contactConsent.findFirst({
    where: { memberId, channel, purpose: "MARKETING" },
    orderBy: { capturedAt: "desc" },
  });
  return latest?.status === "GRANTED";
}

async function serviceEmailRevoked(
  tx: TenantTransaction,
  memberId: string,
): Promise<boolean> {
  const latest = await tx.contactConsent.findFirst({
    where: { memberId, channel: "EMAIL", purpose: "SERVICE" },
    orderBy: { capturedAt: "desc" },
  });
  return latest?.status === "REVOKED";
}

/**
 * Queues a notification inside the caller's transaction (so it is sent only if the change
 * commits). Returns what happened per channel; skipped sends are recorded with a reason.
 */
export async function notify(
  tx: TenantTransaction,
  tenantId: string,
  input: NotifyInput,
): Promise<{
  inApp: "QUEUED" | "SKIPPED" | "NONE";
  email: "QUEUED" | "SKIPPED" | "NONE";
  whatsapp: "QUEUED" | "NONE";
}> {
  const template = TEMPLATES[input.templateKey];
  const channels = input.channels ?? ["IN_APP", "EMAIL", "WHATSAPP"];
  const override = await tx.emailTemplate.findUnique({
    where: { tenantId_key: { tenantId, key: input.templateKey } },
  });
  const title = renderTemplate(template.title, input.data);
  const subject = renderTemplate(
    override?.subject ?? template.subject,
    input.data,
  );
  const body = renderTemplate(override?.body ?? template.body, input.data);
  const { memberId, userId, email } = input.recipient;
  const result = {
    inApp: "NONE" as "QUEUED" | "SKIPPED" | "NONE",
    email: "NONE" as "QUEUED" | "SKIPPED" | "NONE",
    whatsapp: "NONE" as "QUEUED" | "NONE",
  };

  const prefOff = async (channel: "IN_APP" | "EMAIL") => {
    if (template.required || !userId) return false;
    const pref = await tx.notificationPreference.findUnique({
      where: {
        tenantId_userId_templateKey_channel: {
          tenantId,
          userId,
          templateKey: input.templateKey,
          channel,
        },
      },
    });
    return pref?.enabled === false;
  };

  const create = async (
    channel: "IN_APP" | "EMAIL",
    status: "PENDING" | "SKIPPED" | "SENT",
    statusNote?: string,
  ) => {
    if (input.dedupeKey) {
      const existing = await tx.notification.findUnique({
        where: {
          tenantId_channel_dedupeKey: {
            tenantId,
            channel,
            dedupeKey: input.dedupeKey,
          },
        },
      });
      if (existing) return null;
    }
    return tx.notification.create({
      data: {
        tenantId,
        userId: userId ?? null,
        memberId: memberId ?? null,
        email: channel === "EMAIL" ? (email ?? null) : null,
        channel,
        category: template.category,
        templateKey: input.templateKey,
        title,
        body: channel === "EMAIL" ? `${subject}\n\n${body}` : body,
        link: input.link ?? null,
        status,
        statusNote: statusNote ?? null,
        dedupeKey: input.dedupeKey ?? null,
        sentAt: status === "SENT" ? new Date() : null,
      },
    });
  };

  if (channels.includes("IN_APP") && userId) {
    if (await prefOff("IN_APP")) {
      result.inApp = "SKIPPED";
    } else if (await create("IN_APP", "SENT")) {
      result.inApp = "QUEUED";
    }
  }

  if (channels.includes("EMAIL") && email) {
    let skip: string | null = null;
    if (
      template.category === "MARKETING" &&
      (!memberId || !(await hasMarketingConsent(tx, memberId, "EMAIL")))
    ) {
      skip = "No marketing consent for email";
    } else if (
      template.category === "SERVICE" &&
      memberId &&
      !template.required &&
      (await serviceEmailRevoked(tx, memberId))
    ) {
      skip = "Member opted out of service emails";
    } else if (await prefOff("EMAIL")) {
      skip = "Turned off in preferences";
    }
    const row = await create(
      "EMAIL",
      skip ? "SKIPPED" : "PENDING",
      skip ?? undefined,
    );
    if (row && !skip) {
      await tx.outbox.create({
        data: {
          tenantId,
          topic: "notification.email",
          payload: { notificationId: row.id },
        },
      });
      result.email = "QUEUED";
    } else if (row) {
      result.email = "SKIPPED";
    }
  }

  // Consent, suppression and the template's approval are checked when the worker sends it.
  if (channels.includes("WHATSAPP") && template.category === "SERVICE")
    result.whatsapp = await queueWhatsAppNotification(
      tx,
      tenantId,
      input,
      randomUUID(),
    );
  return result;
}

/** The signed-in user's in-app notifications in this tenant, newest first. */
export async function listMyNotifications(
  db: PrismaClient,
  tenantId: string,
  userId: string,
  take = 20,
) {
  return withTenant(db, tenantId, async (tx) => {
    const [rows, unread] = await inOrder([
      tx.notification.findMany({
        where: { userId, channel: "IN_APP" },
        orderBy: { createdAt: "desc" },
        take,
      }),
      tx.notification.count({
        where: { userId, channel: "IN_APP", readAt: null },
      }),
    ]);
    return { rows, unread };
  });
}

export async function markNotificationsRead(
  db: PrismaClient,
  tenantId: string,
  userId: string,
  ids: string[] | "all",
): Promise<number> {
  const result = await withTenant(db, tenantId, (tx) =>
    tx.notification.updateMany({
      where: {
        userId,
        channel: "IN_APP",
        readAt: null,
        ...(ids === "all" ? {} : { id: { in: ids } }),
      },
      data: { readAt: new Date() },
    }),
  );
  return result.count;
}

export type EmailDelivery = (message: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

/**
 * Worker side: sends one queued EMAIL notification. Idempotent: anything not PENDING is left
 * alone, so a retried job never sends twice after success.
 */
export async function deliverEmailNotification(
  tx: TenantTransaction,
  notificationId: string,
  send: EmailDelivery,
): Promise<"SENT" | "ALREADY_DONE"> {
  const row = await tx.notification.findUnique({
    where: { id: notificationId },
  });
  if (!row) throw new AppError("NOT_FOUND", "Notification not found");
  if (row.status !== "PENDING" || row.channel !== "EMAIL" || !row.email)
    return "ALREADY_DONE";
  const [subject, ...rest] = row.body.split("\n\n");
  await send({
    to: row.email,
    subject: subject ?? row.title,
    text: rest.join("\n\n"),
  });
  await tx.notification.update({
    where: { id: row.id },
    data: { status: "SENT", sentAt: new Date() },
  });
  return "SENT";
}

export async function setNotificationPreference(
  db: PrismaClient,
  tenantId: string,
  userId: string,
  templateKey: TemplateKey,
  channel: "IN_APP" | "EMAIL",
  enabled: boolean,
): Promise<void> {
  if (TEMPLATES[templateKey].required) {
    throw new AppError(
      "VALIDATION_FAILED",
      "This message can't be turned off.",
    );
  }
  await withTenant(db, tenantId, (tx) =>
    tx.notificationPreference.upsert({
      where: {
        tenantId_userId_templateKey_channel: {
          tenantId,
          userId,
          templateKey,
          channel,
        },
      },
      create: { tenantId, userId, templateKey, channel, enabled },
      update: { enabled },
    }),
  );
}
