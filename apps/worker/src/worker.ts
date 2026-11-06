import { QUEUE_NAMES, type JobName, type QueueName } from "@gym/core/jobs";
import type { Logger } from "@gym/core/logger";
import type { PlatformDeps } from "@gym/core/platform";
import type { PrismaClient } from "@gym/db";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { buildContext, type JobContext, type WorkerServices } from "./context";
import { PROCESSORS } from "./processors";

export class JobTimeoutError extends Error {
  constructor(job: string, ms: number) {
    super(`Job "${job}" timed out after ${ms} ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Fails the job when it runs past `ms` (BullMQ has no job timeout of its own). The handler's
 * signal is aborted so it can stop; the job is retried with backoff like any other failure.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  controller: AbortController,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(name, ms));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts one BullMQ Worker per queue in the catalogue. */
export function startWorkers(
  connection: Redis,
  db: PrismaClient,
  log: Logger,
  platform: PlatformDeps | null = null,
  services: WorkerServices | null = null,
): Worker[] {
  return QUEUE_NAMES.map((queue: QueueName) => {
    const { concurrency, timeoutMs, handlers } = PROCESSORS[queue];

    const worker = new Worker(
      queue,
      async (job) => {
        const handler = (
          handlers as Record<
            string,
            | ((
                ctx: JobContext<QueueName, JobName<QueueName>>,
              ) => Promise<unknown>)
            | undefined
          >
        )[job.name];
        if (!handler) {
          throw new Error(`No handler for job "${queue}/${job.name}"`);
        }
        const controller = new AbortController();
        const ctx = buildContext(
          queue,
          job,
          db,
          log,
          platform,
          controller.signal,
          services,
        );
        return withTimeout(
          handler(ctx),
          timeoutMs,
          controller,
          `${queue}/${job.name}`,
        );
      },
      { connection, concurrency },
    );

    worker.on("failed", (job, err) => {
      log.error(
        {
          queue,
          jobId: job?.id,
          jobName: job?.name,
          attempt: job?.attemptsMade,
          maxAttempts: job?.opts.attempts,
          err,
        },
        "job failed",
      );
    });
    worker.on("error", (err) => log.error({ queue, err }, "worker error"));

    return worker;
  });
}
