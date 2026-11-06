import { noEntitlementCache } from "@gym/core/entitlements";
import { closeQueues, createRedisConnection, getQueue } from "@gym/core/jobs";
import { createLogger } from "@gym/core/logger";
import { notify } from "@gym/core/notifications";
import { createTenantForOwner } from "@gym/core/tenancy";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import type { EmailMessage } from "@gym/integrations/email";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildContext, type WorkerServices } from "../src/context";
import { outboxRelay, sendEmail } from "../src/processors/m2";

// Redis logical database 14 (queue.int.test uses 15), so development queues are never touched.
function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  url.pathname = "/14";
  return url.toString();
}

const log = createLogger({ name: "outbox-test", level: "silent" });
const sent: EmailMessage[] = [];

let db: TestDatabase;
let prisma: PrismaClient;
let owner: PrismaClient;
let redis: Redis;
let services: WorkerServices;

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  redis = createRedisConnection(testRedisUrl());
  await redis.flushdb();
  services = {
    db: prisma,
    redis,
    email: { send: async (m: EmailMessage) => void sent.push(m) },
    storage: {} as WorkerServices["storage"],
    brand: "Gym SaaS",
    appUrl: "http://localhost:3000",
  };
});

afterAll(async () => {
  await closeQueues();
  await redis?.flushdb();
  redis?.disconnect();
  await prisma?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

const job = (name: string, data: unknown) =>
  ({ id: "test", name, data }) as unknown as Job;

it("relays an email notification once: outbox row DONE on the first attempt, one email sent", async () => {
  const user = await prisma.user.create({
    data: {
      email: "relay-owner@x.test",
      name: "Relay Owner",
      emailVerified: true,
    },
  });
  const { tenantId } = await createTenantForOwner(
    { db: prisma, entitlements: noEntitlementCache },
    { userId: user.id },
    { gymName: "Relay Gym", stateCode: "08", branchName: "Main" },
  );
  await withTenant(prisma, tenantId, (tx) =>
    notify(tx, tenantId, {
      templateKey: "membership.activated",
      recipient: { email: "member@x.test" },
      data: { plan: "Monthly", gym: "Relay Gym" },
      channels: ["EMAIL"],
    }),
  );

  const relay = buildContext(
    "outbox",
    job("outbox.relay", {
      tenantId: null,
      actor: { type: "system" },
      idempotencyKey: "relay-1",
      data: {},
    }),
    prisma,
    log,
    null,
    undefined,
    services,
  );
  expect(await outboxRelay(relay as never)).toEqual({ relayed: 1 });

  const rows = await owner.$queryRaw<
    { status: string; attempts: number; last_error: string | null }[]
  >`
    SELECT status::text, attempts, last_error FROM app.outbox WHERE tenant_id = ${tenantId}::uuid`;
  expect(rows).toEqual([{ status: "DONE", attempts: 1, last_error: null }]);
  // Nothing left to claim.
  expect(await outboxRelay(relay as never)).toEqual({ relayed: 0 });

  const queued = await getQueue("notifications", redis).getJobs([
    "waiting",
    "delayed",
    "prioritized",
  ]);
  expect(queued).toHaveLength(1);
  const deliver = buildContext(
    "notifications",
    job(queued[0]!.name, queued[0]!.data),
    prisma,
    log,
    null,
    undefined,
    services,
  );
  await sendEmail(deliver as never);
  await sendEmail(deliver as never); // a retried job must not send twice
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    to: "member@x.test",
    subject: "Your Monthly membership is active",
  });
});
