import type { JobName, QueueName } from "@gym/core/jobs";
import type { JobContext } from "../context";
import { expireTrials } from "./expire-trials";
import {
  dailyScan,
  membersExport,
  membersImport,
  membershipsDaily,
  outboxRelay,
  sendEmail,
} from "./m2";
import { classesDaily, classesTick, floorScan } from "./m3";
import {
  billingLifecycle,
  billingWebhook,
  paymentsDaily,
  paymentsReconcile,
  paymentsScan,
  paymentsWebhook,
} from "./m4";
import {
  crmScan,
  crmTick,
  eventsDispatch,
  leadsExport,
  leadsImport,
} from "./m5";
import {
  automationRun,
  engagementDaily,
  growthDaily,
  messagingEvent,
  messagingScan,
  messagingSend,
  messagingSyncTemplates,
  messagingTick,
} from "./m6";
import { metricsRollup, reportsExport } from "./m8";
import { systemPing } from "./system-ping";

type Handlers = {
  [Q in QueueName]: {
    concurrency: number;
    /** A job running longer than this fails (and is retried with backoff). */
    timeoutMs: number;
    handlers: {
      [N in JobName<Q>]?: (ctx: JobContext<Q, N>) => Promise<unknown>;
    };
  };
};

/** queue → job name → handler, plus how many jobs of that queue run at once. */
export const PROCESSORS: Handlers = {
  system: {
    concurrency: 5,
    timeoutMs: 10_000,
    handlers: {
      "system.ping": systemPing,
    },
  },
  platform: {
    concurrency: 1,
    timeoutMs: 5 * 60_000,
    handlers: {
      "platform.expire-trials": expireTrials,
      "platform.daily-scan": dailyScan,
      "platform.floor-scan": floorScan,
      "platform.payments-scan": paymentsScan,
      "platform.billing-webhook": billingWebhook,
      "platform.billing-lifecycle": billingLifecycle,
      "platform.crm-scan": crmScan,
      "platform.messaging-scan": messagingScan,
    },
  },
  /** M6: WhatsApp. Sends are short HTTP calls; retries come from the job's backoff. */
  messaging: {
    concurrency: 5,
    timeoutMs: 60_000,
    handlers: {
      "messaging.send": messagingSend,
      "messaging.event": messagingEvent,
      "messaging.tick": messagingTick,
      "messaging.sync-templates": messagingSyncTemplates,
    },
  },
  automation: {
    concurrency: 4,
    timeoutMs: 60_000,
    handlers: { "automation.run": automationRun },
  },
  growth: {
    concurrency: 1,
    timeoutMs: 10 * 60_000,
    handlers: { "growth.daily": growthDaily },
  },
  engagement: {
    concurrency: 1,
    timeoutMs: 10 * 60_000,
    handlers: { "engagement.daily": engagementDaily },
  },
  metrics: {
    concurrency: 1,
    timeoutMs: 10 * 60_000,
    handlers: { "metrics.rollup": metricsRollup },
  },
  payments: {
    concurrency: 4,
    timeoutMs: 2 * 60_000,
    handlers: {
      "payments.webhook": paymentsWebhook,
      "payments.reconcile": paymentsReconcile,
      "payments.daily": paymentsDaily,
    },
  },
  classes: {
    concurrency: 2,
    timeoutMs: 5 * 60_000,
    handlers: {
      "classes.tick": classesTick,
      "classes.daily": classesDaily,
    },
  },
  /** M5: domain events → handlers (each once); CRM housekeeping. */
  events: {
    concurrency: 5,
    timeoutMs: 60_000,
    handlers: { "events.dispatch": eventsDispatch },
  },
  crm: {
    concurrency: 2,
    timeoutMs: 2 * 60_000,
    handlers: { "crm.tick": crmTick },
  },
  outbox: {
    concurrency: 1,
    timeoutMs: 30_000,
    handlers: { "outbox.relay": outboxRelay },
  },
  notifications: {
    concurrency: 5,
    timeoutMs: 30_000,
    handlers: { "notifications.send-email": sendEmail },
  },
  memberships: {
    concurrency: 2,
    timeoutMs: 5 * 60_000,
    handlers: { "memberships.daily": membershipsDaily },
  },
  data: {
    concurrency: 1,
    timeoutMs: 10 * 60_000,
    handlers: {
      "members.import": membersImport,
      "members.export": membersExport,
      "leads.import": leadsImport,
      "leads.export": leadsExport,
      "reports.export": reportsExport,
    },
  },
};
