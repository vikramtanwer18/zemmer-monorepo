import { randomUUID } from "node:crypto";
import { AppError } from "@gym/core/errors";
import {
  closeQueues,
  createRedisConnection,
  enqueue,
  getQueue,
} from "@gym/core/jobs";
import { createLogger } from "@gym/core/logger";
import { createPrismaClient, type PrismaClient } from "@gym/db";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { QueueEvents, type Job, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext } from "../src/context";
import { startWorkers } from "../src/worker";

// Redis logical database 15, so development queues are never touched.
function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  url.pathname = "/15";
  return url.toString();
}

const log = createLogger({ name: "worker-test", level: "silent" });

let db: TestDatabase;
let prisma: PrismaClient;
let redis: Redis;
let eventsRedis: Redis;
let events: QueueEvents;
let workers: Worker[];

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = createPrismaClient(db.appUrl);
  redis = createRedisConnection(testRedisUrl());
  await redis.flushdb();
  eventsRedis = createRedisConnection(testRedisUrl());
  events = new QueueEvents("system", { connection: eventsRedis });
  await events.waitUntilReady();
  workers = startWorkers(redis, prisma, log);
});

afterAll(async () => {
  await Promise.all((workers ?? []).map((w) => w.close()));
  await events?.close();
  await closeQueues();
  await redis?.flushdb();
  redis?.disconnect();
  eventsRedis?.disconnect();
  await prisma?.$disconnect();
  await db?.drop();
});

function ping(idempotencyKey: string, data: unknown = { message: "hello" }) {
  return {
    tenantId: null,
    actor: { type: "system" as const },
    idempotencyKey,
    data: data as { message: string },
  };
}

describe("job queue", () => {
  it("a ping job goes from producer to worker and returns pong", async () => {
    const job = await enqueue(
      redis,
      "system",
      "system.ping",
      ping(`ping-${randomUUID()}`),
    );
    const result = await job.waitUntilFinished(events);
    expect(result).toEqual({ reply: "pong", message: "hello" });
  });

  it("the same idempotency key added twice gives exactly one completed job", async () => {
    const queue = getQueue("system", redis);
    const before = (await queue.getJobCounts("completed")).completed ?? 0;
    const key = `dedupe-${randomUUID()}`;

    const first = await enqueue(redis, "system", "system.ping", ping(key));
    const second = await enqueue(redis, "system", "system.ping", ping(key));
    expect(second.id).toBe(first.id);
    await first.waitUntilFinished(events);
    await enqueue(redis, "system", "system.ping", ping(key));

    const after = (await queue.getJobCounts("completed")).completed ?? 0;
    expect(after - before).toBe(1);
  });

  it("rejects an invalid payload before it reaches Redis", async () => {
    const key = `invalid-${randomUUID()}`;
    await expect(
      enqueue(redis, "system", "system.ping", ping(key, { nope: true })),
    ).rejects.toBeInstanceOf(AppError);
    expect(await getQueue("system", redis).getJob(key)).toBeUndefined();
  });

  it("tenantDb() inside a job sees exactly that job's tenant id", async () => {
    const tenantId = randomUUID();
    const fakeJob = {
      id: "tenant-probe",
      name: "system.ping",
      data: { ...ping("tenant-probe"), tenantId },
    } as unknown as Job;

    const ctx = buildContext("system", fakeJob, prisma, log);
    const rows = await ctx.tenantDb(
      (tx) =>
        tx.$queryRaw<
          { tenant: string }[]
        >`SELECT app.current_tenant_id()::text AS tenant`,
    );
    expect(rows[0]?.tenant).toBe(tenantId);

    const platformJob = {
      ...fakeJob,
      data: ping("platform-probe"),
    } as unknown as Job;
    expect(() =>
      buildContext("system", platformJob, prisma, log).tenantDb(async () => 1),
    ).toThrow(AppError);
  });
});
