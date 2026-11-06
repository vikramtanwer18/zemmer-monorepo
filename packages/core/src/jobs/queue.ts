import { Queue, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import {
  parseJob,
  type JobEnvelope,
  type JobName,
  type QueueName,
} from "./catalogue";

/** BullMQ workers require `maxRetriesPerRequest: null`. */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  // Failed jobs stay until someone looks at them.
  removeOnFail: false,
};

const queuesByConnection = new WeakMap<Redis, Map<QueueName, Queue>>();
const allQueues = new Set<Queue>();

/** One Queue per name (per Redis connection), created on first use. */
export function getQueue(name: QueueName, connection: Redis): Queue {
  let queues = queuesByConnection.get(connection);
  if (!queues) {
    queues = new Map();
    queuesByConnection.set(connection, queues);
  }
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
    allQueues.add(queue);
  }
  return queue;
}

/**
 * Validates, then adds the job with `jobId` = idempotency key.
 * Adding the same key twice creates one job.
 */
export async function enqueue<Q extends QueueName, N extends JobName<Q>>(
  connection: Redis,
  queue: Q,
  name: N,
  envelope: JobEnvelope<Q, N>,
): Promise<Job> {
  const parsed = parseJob(queue, name, envelope);
  return getQueue(queue, connection).add(name, parsed, {
    ...DEFAULT_JOB_OPTIONS,
    jobId: parsed.idempotencyKey,
  });
}

export async function closeQueues(): Promise<void> {
  const queues = [...allQueues];
  allQueues.clear();
  await Promise.all(queues.map((queue) => queue.close()));
}
