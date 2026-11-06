import { AppError } from "@gym/core/errors";
import {
  parseJob,
  type JobEnvelope,
  type JobName,
  type QueueName,
} from "@gym/core/jobs";
import type { Logger } from "@gym/core/logger";
import type { PlatformDeps } from "@gym/core/platform";
import type { BillingDeps } from "@gym/core/saas-billing";
import type { CoreDeps } from "@gym/core/tenancy";
import { withTenant, type PrismaClient, type TenantTransaction } from "@gym/db";
import type { EmailSender } from "@gym/integrations/email";
import type { S3Storage } from "@gym/integrations/storage";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";

/** Shared clients for handlers. `db` is the gym_app client (RLS applies; no tenant set). */
export type WorkerServices = {
  db: PrismaClient;
  redis: Redis;
  email: EmailSender;
  storage: S3Storage;
  brand: string;
  appUrl: string;
  /** M4: gym-side services (gym_app) with secrets and the payment provider factory. */
  deps?: CoreDeps;
  /** M4: SaaS billing (gym_platform). */
  billing?: BillingDeps;
};

export type JobContext<Q extends QueueName, N extends JobName<Q>> = {
  job: Job;
  envelope: JobEnvelope<Q, N>;
  log: Logger;
  /** Runs database work as the job's tenant (RLS applies). Refuses platform-wide jobs. */
  tenantDb: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  /** Platform services (gym_platform role). Only platform-wide jobs (tenantId null) may use them. */
  platform: () => PlatformDeps;
  /** Aborted when the job hits its queue's timeout; long handlers should check it. */
  signal: AbortSignal;
  services: () => WorkerServices;
};

/**
 * Never trusts the payload: re-validates it against the catalogue and re-establishes the tenant
 * context itself, so a stale or hand-crafted job still cannot touch another gym's data.
 */
export function buildContext<Q extends QueueName, N extends JobName<Q>>(
  queue: Q,
  job: Job,
  db: PrismaClient,
  log: Logger,
  platform: PlatformDeps | null = null,
  signal: AbortSignal = new AbortController().signal,
  services: WorkerServices | null = null,
): JobContext<Q, N> {
  const envelope = parseJob(queue, job.name as N, job.data);
  return {
    job,
    envelope,
    signal,
    services: () => {
      if (!services)
        throw new AppError("INTERNAL", "Worker services are not configured");
      return services;
    },
    log: log.child({
      queue,
      jobId: job.id,
      jobName: job.name,
      tenantId: envelope.tenantId,
    }),
    tenantDb: (fn) => {
      if (!envelope.tenantId) {
        throw new AppError(
          "FORBIDDEN",
          `Job "${job.name}" has no tenant; tenantDb() is not allowed`,
        );
      }
      return withTenant(db, envelope.tenantId, fn);
    },
    platform: () => {
      if (envelope.tenantId !== null || !platform) {
        throw new AppError(
          "FORBIDDEN",
          `Job "${job.name}" may not use platform services`,
        );
      }
      return platform;
    },
  };
}
