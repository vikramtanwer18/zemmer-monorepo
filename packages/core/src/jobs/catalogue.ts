import { z } from "zod";
import { AppError } from "../errors";

export const actorSchema = z.object({
  type: z.enum(["user", "system"]),
  id: z.string().min(1).optional(),
});

/** BullMQ uses this as the job id, and rejects ids containing ":" or made only of digits. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => !key.includes(":"), "must not contain ':'")
  .refine((key) => !/^\d+$/.test(key), "must not be only digits");

/** Wraps every job's data with who/what/which-tenant. */
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    /** null for platform-wide jobs. */
    tenantId: z.uuid().nullable(),
    actor: actorSchema,
    idempotencyKey: idempotencyKeySchema,
    data,
  });
}

/**
 * Every queue, every job in it, and the schema of its data.
 * Producers and the worker both derive their types from here, so they can never disagree.
 */
export const JOBS = {
  system: {
    "system.ping": z.object({ message: z.string().min(1).max(200) }),
  },
  /** Platform-wide jobs (tenantId null), run on the gym_platform connection. */
  platform: {
    "platform.expire-trials": z.object({}),
    /** Hourly: queues each active tenant's daily membership job for its local date. */
    "platform.daily-scan": z.object({}),
    /** Every 15 minutes: queues each active tenant's classes tick. */
    "platform.floor-scan": z.object({}),
    /** Every 15 minutes: queues each active tenant's quick payment reconciliation. */
    "platform.payments-scan": z.object({}),
    /** A verified SaaS billing webhook to apply. */
    "platform.billing-webhook": z.object({ eventRowId: z.uuid() }),
    /** Hourly: grace ends → suspended, period ends → cancelled, trial reminders. */
    "platform.billing-lifecycle": z.object({}),
    /** M5: every 5 minutes, queues each active tenant's CRM tick. */
    "platform.crm-scan": z.object({}),
    /** M6: every minute, queues each active tenant's messaging tick. */
    "platform.messaging-scan": z.object({}),
  },
  /** M5: domain events from the outbox (topic "event"), delivered to each handler once. */
  events: {
    "events.dispatch": z.object({
      eventId: z.uuid(),
      type: z.string().min(1).max(80),
    }),
  },
  /** M5: per-tenant CRM housekeeping. */
  crm: {
    /** First-contact SLA breaches, task reminders, trial no-shows. */
    "crm.tick": z.object({}),
  },
  /** M6: WhatsApp sends, verified webhook items, campaign dispatch, template sync. */
  messaging: {
    "messaging.send": z.object({ outboundId: z.uuid() }),
    "messaging.event": z.object({ messageEventId: z.uuid() }),
    /** Every minute: campaign batches, automation waits that are over, stuck sends. */
    "messaging.tick": z.object({}),
    "messaging.sync-templates": z.object({ accountId: z.uuid() }),
  },
  /** M6: automation executions (one job runs an execution until it waits or ends). */
  automation: {
    "automation.run": z.object({ executionId: z.uuid() }),
  },
  /** M7: nightly per tenant: streaks, streak milestones, ending challenges. */
  engagement: {
    "engagement.daily": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  /** M8: nightly per tenant: KPI rollup for yesterday (+ 2 days refreshed), Copilot log retention. */
  metrics: {
    "metrics.rollup": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  /** M6: nightly per tenant: template sync, scan triggers, retention flags. */
  growth: {
    "growth.daily": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  /** System jobs (tenantId null) on the gym_app connection, through SECURITY DEFINER functions only. */
  outbox: {
    "outbox.relay": z.object({}),
  },
  notifications: {
    "notifications.send-email": z.object({ notificationId: z.uuid() }),
  },
  memberships: {
    /** Expiry, freezes and reminders for one tenant on its local date. */
    "memberships.daily": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  /** M4: per-tenant online payments. */
  payments: {
    "payments.webhook": z.object({ webhookEventId: z.uuid() }),
    "payments.reconcile": z.object({ kind: z.enum(["QUICK", "DAILY"]) }),
    /** Dues reminders and the daily reconciliation, on the tenant's local date. */
    "payments.daily": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  /** M3: per-tenant floor jobs. */
  classes: {
    /** Close ended classes (no-shows) and send booking reminders. */
    "classes.tick": z.object({}),
    /** Extend class schedules to 8 weeks and expire PT packages, for the tenant's local date. */
    "classes.daily": z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
  data: {
    "members.import": z.object({ dataJobId: z.uuid() }),
    "members.export": z.object({ dataJobId: z.uuid() }),
    "leads.import": z.object({ dataJobId: z.uuid() }),
    "leads.export": z.object({ dataJobId: z.uuid() }),
    /** M8: a report as CSV/XLSX (reports.export), with progress. */
    "reports.export": z.object({ dataJobId: z.uuid() }),
  },
} as const;

type Catalogue = typeof JOBS;
export type QueueName = keyof Catalogue;
export type JobName<Q extends QueueName> = keyof Catalogue[Q] & string;
export type JobData<
  Q extends QueueName,
  N extends JobName<Q>,
> = Catalogue[Q][N] extends z.ZodType ? z.infer<Catalogue[Q][N]> : never;
export type Actor = z.infer<typeof actorSchema>;

export type JobEnvelope<Q extends QueueName, N extends JobName<Q>> = {
  tenantId: string | null;
  actor: Actor;
  idempotencyKey: string;
  data: JobData<Q, N>;
};

export const QUEUE_NAMES = Object.keys(JOBS) as QueueName[];

/** Validates a payload against the catalogue. Runs when a job is added and again when it is processed. */
export function parseJob<Q extends QueueName, N extends JobName<Q>>(
  queue: Q,
  name: N,
  payload: unknown,
): JobEnvelope<Q, N> {
  const jobs = JOBS[queue] as Record<string, z.ZodType> | undefined;
  const schema = jobs?.[name];
  if (!schema) {
    throw new AppError("VALIDATION_FAILED", `Unknown job "${queue}/${name}"`);
  }
  const result = envelopeSchema(schema).safeParse(payload);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Invalid payload for job "${name}"`,
      {
        details: z.prettifyError(result.error),
      },
    );
  }
  return result.data as JobEnvelope<Q, N>;
}
