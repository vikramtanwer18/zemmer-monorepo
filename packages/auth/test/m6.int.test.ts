import {
  AUTOMATION_EVENT_HANDLER,
  decideApproval,
  dryRunWorkflow,
  getWorkflow,
  installLibraryWorkflow,
  listApprovals,
  runAutomationScansTx,
  runExecution,
  saveWorkflow,
  setWorkflowEnabled,
  startExecutionsTx,
} from "@gym/core/automation";
import type { AuthContext } from "@gym/core/authz";
import { recordPayment } from "@gym/core/billing";
import { createLead, saveCampaign } from "@gym/core/crm";
import { createSecretBox } from "@gym/core/crypto";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import { dispatchEvent } from "@gym/core/events";
import {
  campaignStats,
  configureCampaignSend,
  dispatchCampaigns,
  estimateCampaign,
  launchCampaign,
  previewSegment,
  saveSegment,
  testSendCampaign,
} from "@gym/core/growth";
import { createMember } from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import {
  connectWhatsAppAccount,
  deliverMessage,
  getWhatsAppAccount,
  listTemplates,
  processMessageEvent,
  queueMessageTx,
  receiveWhatsAppWebhook,
  replyToConversation,
  RetryableSendError,
  saveNotificationTemplate,
  sendTemplateToContact,
} from "@gym/core/messaging";
import { createPlan } from "@gym/core/plans";
import { retentionDashboard, runRetentionTx } from "@gym/core/retention";
import {
  createTenantForOwner,
  loadTenantAccess,
  type CoreDeps,
} from "@gym/core/tenancy";
import { addDays, todayIn, toDbDate } from "@gym/core/time/dates";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import { memoryFakeStore } from "@gym/integrations/payments";
import {
  fakeWebhooks,
  FakeWhatsAppClient,
  signMetaWebhook,
  whatsappClientFactory,
} from "@gym/integrations/whatsapp";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsFor } from "../src/permissions";

const APP_SECRET = "m6-test-meta-app-secret";
let db: TestDatabase;
let app: PrismaClient;
let owner: PrismaClient;
let deps: CoreDeps;
let fake: FakeWhatsAppClient;

type Gym = {
  tenantId: string;
  slug: string;
  branchId: string;
  ctx: AuthContext;
  waba: string;
  number: string;
};

async function ctxFor(userId: string, tenantId: string): Promise<AuthContext> {
  const access = await loadTenantAccess(app, userId, tenantId);
  if (!access) throw new Error("no access");
  return {
    userId,
    tenantId,
    membershipId: access.membershipId,
    grants: grantsFor(access.roles),
    activeBranchId: null,
    tenantStatus: access.tenant.status,
    subscriptionStatus: access.subscription?.status ?? null,
    timezone: access.tenant.timezone,
  };
}

let seq = 0;
async function addStaff(
  gym: Gym,
  roleKey: string,
  branchId: string | null = null,
) {
  seq++;
  const user = await app.user.create({
    data: {
      email: `${roleKey.toLowerCase()}${seq}@${gym.slug}.test`,
      name: `${roleKey} ${seq}`,
      emailVerified: true,
    },
  });
  await withTenant(app, gym.tenantId, async (tx) => {
    const m = await tx.tenantMembership.create({
      data: { tenantId: gym.tenantId, userId: user.id },
    });
    await tx.roleAssignment.create({
      data: { tenantId: gym.tenantId, membershipId: m.id, roleKey, branchId },
    });
  });
  return ctxFor(user.id, gym.tenantId);
}

let wabaSeq = 100_000_000;
async function makeGym(name: string, plan = "growth"): Promise<Gym> {
  const user = await app.user.create({
    data: {
      email: `owner@${name.toLowerCase()}.test`,
      name: `${name} Owner`,
      emailVerified: true,
    },
  });
  const { tenantId } = await createTenantForOwner(
    deps,
    { userId: user.id },
    { gymName: name, stateCode: "08", branchName: `${name} Main` },
  );
  await owner.$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = ${plan} ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${tenantId}::uuid`;
  const branchId = await withTenant(
    app,
    tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const tenant = await owner.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  wabaSeq++;
  return {
    tenantId,
    slug: tenant.slug,
    branchId,
    ctx: await ctxFor(user.id, tenantId),
    waba: String(wabaSeq),
    number: String(wabaSeq + 500_000_000),
  };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) {
      expect(err.code, err.message).toBe(code);
      return err;
    }
    throw err;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

const connect = (gym: Gym) =>
  connectWhatsAppAccount(
    deps,
    gym.ctx,
    {
      method: "FAKE",
      wabaId: gym.waba,
      phoneNumberId: gym.number,
      accessToken: `EAAG-test-token-${gym.slug}-0001`,
    },
    { allowFake: true },
  );

async function post(body: string, secret = APP_SECRET) {
  return receiveWhatsAppWebhook(app, {
    rawBody: body,
    signature: signMetaWebhook(body, secret),
    appSecret: APP_SECRET,
  });
}

/** Does what the relay + worker do, synchronously: message sends, webhook items, automations, events. */
async function drain(gym: Gym, d: CoreDeps = deps) {
  for (let round = 0; round < 20; round++) {
    const rows = await owner.outbox.findMany({
      where: {
        tenantId: gym.tenantId,
        status: "PENDING",
        topic: {
          in: ["message.send", "message.event", "automation.run", "event"],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!rows.length) return;
    for (const r of rows) {
      await owner.outbox.update({
        where: { id: r.id },
        data: { status: "DONE", processedAt: new Date() },
      });
      const p = r.payload as Record<string, string>;
      if (r.topic === "message.send")
        await deliverMessage(d, gym.tenantId, p.outboundId!, {
          finalAttempt: false,
        }).catch((e: unknown) => {
          if (!(e instanceof RetryableSendError)) throw e;
        });
      else if (r.topic === "message.event")
        await processMessageEvent(d, gym.tenantId, p.messageEventId!, {
          finalAttempt: true,
        });
      else if (r.topic === "automation.run")
        await runExecution(d, gym.tenantId, p.executionId!, {
          finalAttempt: false,
        });
      else
        await dispatchEvent(app, gym.tenantId, r.id, [
          AUTOMATION_EVENT_HANDLER,
        ]);
    }
  }
}

const outbound = (gym: Gym, where: Record<string, unknown> = {}) =>
  withTenant(app, gym.tenantId, (tx) =>
    tx.outboundMessage.findMany({ where, orderBy: { queuedAt: "asc" } }),
  );

let A: Gym;
let B: Gym;
let plan: { id: string };
let n = 0;
const phoneOf = () => `9${String(810_000_000 + ++n)}`;
const tpl = async (gym: Gym, name: string) =>
  (await listTemplates(deps, gym.ctx)).find((t) => t.name === name)!;

async function member(
  gym: Gym,
  opts: { marketing?: boolean; tags?: string[] } = {},
) {
  const phone = phoneOf();
  const m = await createMember(deps, gym.ctx, {
    firstName: `Mem${n}`,
    phone,
    homeBranchId: gym.branchId,
    ...(opts.marketing ? { marketingWhatsapp: "on" } : {}),
  });
  if (opts.tags)
    await withTenant(app, gym.tenantId, (tx) =>
      tx.memberProfile.update({
        where: { id: m.id },
        data: { tags: opts.tags },
      }),
    );
  return { id: m.id, phone: `+91${phone}` };
}

async function activeMembership(gym: Gym, memberId: string) {
  const sale = await sellMembership(deps, gym.ctx, {
    memberId,
    planId: plan.id,
  });
  await recordPayment(deps, gym.ctx, {
    memberId,
    method: "CASH",
    amountMinor: Number(sale.invoice.totalMinor),
    allocations: [
      {
        invoiceId: sale.invoice.id,
        amountMinor: Number(sale.invoice.totalMinor),
      },
    ],
  });
  return sale.membership;
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  const store = memoryFakeStore();
  const factory = whatsappClientFactory({ fakeEnabled: true, store });
  fake = factory("FAKE") as FakeWhatsAppClient;
  deps = {
    db: app,
    entitlements: noEntitlementCache,
    secrets: createSecretBox({
      key: "m6-integration-test-kek-0123456789abcdef",
    }),
    appUrl: "http://localhost:3000",
    whatsapp: factory,
  };
  A = await makeGym("Aqua");
  B = await makeGym("Blaze");
  plan = await createPlan(deps, A.ctx, {
    name: "Monthly",
    price: "1000",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "PRORATA",
  });
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

describe("connecting a gym's own WABA", () => {
  it("needs the plan feature and the permission; the fake only where allowed", async () => {
    const C = await makeGym("Cobalt", "starter");
    await expectCode(connect(C), "ENTITLEMENT_REQUIRED");
    const sales = await addStaff(A, "SALES_STAFF");
    await expectCode(
      connectWhatsAppAccount(
        deps,
        sales,
        {
          method: "FAKE",
          wabaId: A.waba,
          phoneNumberId: A.number,
          accessToken: "x".repeat(30),
        },
        { allowFake: true },
      ),
      "FORBIDDEN",
    );
    await expectCode(
      connectWhatsAppAccount(deps, A.ctx, {
        method: "FAKE",
        wabaId: A.waba,
        phoneNumberId: A.number,
        accessToken: "x".repeat(30),
      }),
      "FORBIDDEN",
    );
    // WhatsApp says the token is bad (code 190): a field error, nothing stored.
    await expectCode(
      connectWhatsAppAccount(
        deps,
        A.ctx,
        {
          method: "FAKE",
          wabaId: A.waba,
          phoneNumberId: A.number,
          accessToken: "wrong-token-0000000000",
        },
        { allowFake: true },
      ),
      "VALIDATION_FAILED",
    );
    expect(
      await withTenant(app, A.tenantId, (tx) => tx.whatsAppAccount.count()),
    ).toBe(0);
  });

  it("verifies, subscribes, seals the token and syncs templates; a number belongs to one gym", async () => {
    const r = await connect(A);
    expect(r.sync).toMatchObject({ synced: 7 });
    const view = await getWhatsAppAccount(deps, A.ctx);
    expect(view).toMatchObject({
      status: "ACTIVE",
      connectionMethod: "FAKE",
      webhookSubscribed: true,
      approvedTemplates: 6,
      tokenLast4: "0001",
    });
    expect(JSON.stringify(view)).not.toContain("EAAG-test-token");
    const stored = await withTenant(app, A.tenantId, (tx) =>
      tx.whatsAppAccount.findFirstOrThrow(),
    );
    expect(stored.accessTokenEnc).not.toContain("EAAG");
    const t = await tpl(A, "festive_offer");
    expect(t).toMatchObject({
      category: "MARKETING",
      parameterFormat: "NAMED",
      variables: ["first_name", "gym"],
    });
    await expectCode(
      connectWhatsAppAccount(
        deps,
        B.ctx,
        {
          method: "FAKE",
          wabaId: B.waba,
          phoneNumberId: A.number,
          accessToken: "EAAG-another-token-000",
        },
        { allowFake: true },
      ),
      "CONFLICT",
    );
    await connect(B);
  });
});

describe("webhook intake", () => {
  it("rejects a forged signature and stores nothing", async () => {
    const body = fakeWebhooks.inbound({
      wabaId: A.waba,
      phoneNumberId: A.number,
      from: "919000000001",
      text: "hi",
    });
    expect(await post(body, "not-the-secret")).toEqual({
      ok: false,
      status: 401,
    });
    expect(
      await receiveWhatsAppWebhook(app, {
        rawBody: body,
        signature: null,
        appSecret: APP_SECRET,
      }),
    ).toEqual({ ok: false, status: 401 });
    expect(
      await receiveWhatsAppWebhook(app, {
        rawBody: body,
        signature: signMetaWebhook(body, APP_SECRET),
        appSecret: undefined,
      }),
    ).toEqual({ ok: false, status: 401 });
    expect(
      await withTenant(app, A.tenantId, (tx) => tx.messageEvent.count()),
    ).toBe(0);
  });

  it("routes by phone number id; WABA X's events never touch tenant Y; duplicates stored once", async () => {
    const body = fakeWebhooks.inbound({
      wabaId: A.waba,
      phoneNumberId: A.number,
      from: "919000000002",
      text: "Hello",
      messageId: "wamid.IN-A-1",
    });
    expect(await post(body)).toMatchObject({ ok: true, accepted: 1 });
    expect(await post(body)).toMatchObject({
      ok: true,
      accepted: 0,
      duplicates: 1,
    });
    // A's number with B's WABA id: dropped, not guessed.
    const mixed = fakeWebhooks.inbound({
      wabaId: B.waba,
      phoneNumberId: A.number,
      from: "919000000003",
      text: "x",
    });
    expect(await post(mixed)).toMatchObject({
      ok: true,
      accepted: 0,
      unrouted: 1,
    });
    expect(
      await post(
        fakeWebhooks.inbound({
          wabaId: "1",
          phoneNumberId: "999",
          from: "1",
          text: "x",
        }),
      ),
    ).toMatchObject({ unrouted: 1 });
    await drain(A);
    const convA = await withTenant(app, A.tenantId, (tx) =>
      tx.conversation.findMany({ include: { inbound: true } }),
    );
    expect(convA).toHaveLength(1);
    expect(convA[0]).toMatchObject({ phone: "+919000000002", unread: 1 });
    expect(convA[0]!.inbound).toHaveLength(1);
    expect(
      await withTenant(app, B.tenantId, (tx) => tx.conversation.count()),
    ).toBe(0);
    expect(
      await withTenant(app, B.tenantId, (tx) => tx.messageEvent.count()),
    ).toBe(0);
  });

  it("free text only inside the 24-hour window", async () => {
    const conv = await withTenant(app, A.tenantId, (tx) =>
      tx.conversation.findFirstOrThrow({ where: { phone: "+919000000002" } }),
    );
    await replyToConversation(deps, A.ctx, conv.id, {
      body: "Hi! How can we help?",
    });
    await drain(A);
    expect((await outbound(A, { toPhone: "+919000000002" }))[0]).toMatchObject({
      kind: "TEXT",
      status: "SENT",
    });
    const later = { ...deps, now: () => new Date(Date.now() + 25 * 3600_000) };
    await expectCode(
      replyToConversation(later, A.ctx, conv.id, { body: "Still there?" }),
      "CONFLICT",
    );
  });
});

describe("sending: consent, suppression, cap, retries", () => {
  it("UTILITY needs service consent, MARKETING needs marketing consent (checked at send time)", async () => {
    const plain = await member(A);
    const fan = await member(A, { marketing: true });
    const renewal = await tpl(A, "membership_renewal_reminder");
    const offer = await tpl(A, "festive_offer");
    for (const [m, t, key] of [
      [plain, renewal, "u1"],
      [plain, offer, "m1"],
      [fan, offer, "m2"],
      [fan, offer, "m3"],
    ] as const)
      await withTenant(app, A.tenantId, (tx) =>
        queueMessageTx(tx, A.tenantId, {
          kind: "TEMPLATE",
          templateId: t.id,
          values: {
            first_name: "X",
            gym: "Aqua",
            "1": "X",
            "2": "Monthly",
            "3": "1 Dec",
          },
          toPhone: m.phone,
          memberId: m.id,
          purpose: "CAMPAIGN",
          idempotencyKey: `t-${key}`,
        }),
      );
    await drain(A);
    const rows = Object.fromEntries(
      (await outbound(A, { idempotencyKey: { startsWith: "t-" } })).map((r) => [
        r.idempotencyKey,
        r,
      ]),
    );
    expect(rows["t-u1"]).toMatchObject({ status: "SENT" });
    expect(rows["t-m1"]).toMatchObject({
      status: "SKIPPED",
      skipReason: "NO_MARKETING_CONSENT",
    });
    expect(rows["t-m2"]).toMatchObject({ status: "SENT" });
    // Second promotional message to the same number today: the daily cap (1) stops it.
    expect(rows["t-m3"]).toMatchObject({
      status: "SKIPPED",
      skipReason: "DAILY_CAP",
    });
    // Same key again: no second row, no second send.
    const again = await withTenant(app, A.tenantId, (tx) =>
      queueMessageTx(tx, A.tenantId, {
        kind: "TEMPLATE",
        templateId: offer.id,
        values: {},
        toPhone: fan.phone,
        memberId: fan.id,
        purpose: "CAMPAIGN",
        idempotencyKey: "t-m2",
      }),
    );
    expect(again).toMatchObject({ queued: true, created: false });
  });

  it("a transient failure is retried and the message is sent exactly once", async () => {
    const m = await member(A);
    const renewal = await tpl(A, "membership_renewal_reminder");
    const q = await withTenant(app, A.tenantId, (tx) =>
      queueMessageTx(tx, A.tenantId, {
        kind: "TEMPLATE",
        templateId: renewal.id,
        values: { "1": "A", "2": "B", "3": "C" },
        toPhone: m.phone,
        memberId: m.id,
        purpose: "NOTIFICATION",
        idempotencyKey: "retry-1",
      }),
    );
    if (!q.queued) throw new Error("not queued");
    const before = (await fake.sent(A.number)).length;
    await fake.failNext(A.number, "130429");
    await expect(
      deliverMessage(deps, A.tenantId, q.id, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RetryableSendError);
    expect((await outbound(A, { id: q.id }))[0]).toMatchObject({
      status: "QUEUED",
      errorCode: "130429",
      attempts: 1,
    });
    expect(
      await deliverMessage(deps, A.tenantId, q.id, { finalAttempt: false }),
    ).toMatchObject({ status: "SENT" });
    expect(
      await deliverMessage(deps, A.tenantId, q.id, { finalAttempt: false }),
    ).toMatchObject({ status: "NOOP" });
    expect((await fake.sent(A.number)).length - before).toBe(1);
    // A permanent error is recorded with its reason, never retried.
    const q2 = await withTenant(app, A.tenantId, (tx) =>
      queueMessageTx(tx, A.tenantId, {
        kind: "TEMPLATE",
        templateId: renewal.id,
        values: { "1": "A", "2": "B", "3": "C" },
        toPhone: m.phone,
        memberId: m.id,
        purpose: "NOTIFICATION",
        idempotencyKey: "perm-1",
      }),
    );
    if (!q2.queued) throw new Error("not queued");
    await fake.failNext(A.number, "131026");
    expect(
      await deliverMessage(deps, A.tenantId, q2.id, { finalAttempt: false }),
    ).toMatchObject({ status: "FAILED", code: "131026" });
  });

  it("the same send delivered twice at once goes out once and stays SENT (no daily-cap mix-up)", async () => {
    const m = await member(A, { marketing: true });
    const offer = await tpl(A, "festive_offer");
    const q = await withTenant(app, A.tenantId, (tx) =>
      queueMessageTx(tx, A.tenantId, {
        kind: "TEMPLATE",
        templateId: offer.id,
        values: { first_name: "R", gym: "Aqua" },
        toPhone: m.phone,
        memberId: m.id,
        purpose: "CAMPAIGN",
        idempotencyKey: "race-1",
      }),
    );
    if (!q.queued) throw new Error("not queued");
    const before = (await fake.sent(A.number)).length;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        deliverMessage(deps, A.tenantId, q.id, { finalAttempt: false }),
      ),
    );
    expect(results.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(results.filter((r) => r.status === "SKIPPED")).toHaveLength(0);
    expect((await outbound(A, { id: q.id }))[0]).toMatchObject({
      status: "SENT",
    });
    expect((await fake.sent(A.number)).length - before).toBe(1);
  });

  it("delivery statuses only move forward, even out of order", async () => {
    const sent = (await outbound(A, { idempotencyKey: "retry-1" }))[0]!;
    const st = (status: "delivered" | "read" | "failed") =>
      fakeWebhooks.status({
        wabaId: A.waba,
        phoneNumberId: A.number,
        messageId: sent.providerMessageId!,
        status,
      });
    await post(st("read"));
    await post(st("delivered"));
    await drain(A);
    expect((await outbound(A, { id: sent.id }))[0]).toMatchObject({
      status: "READ",
      pricingCategory: "utility",
    });
    expect((await outbound(A, { id: sent.id }))[0]!.readAt).not.toBeNull();
  });

  it("STOP: suppression + revoked consent at once, a confirmation reply, START opts back in", async () => {
    const m = await member(A, { marketing: true });
    const offer = await tpl(A, "festive_offer");
    await post(
      fakeWebhooks.inbound({
        wabaId: A.waba,
        phoneNumberId: A.number,
        from: m.phone.slice(1),
        text: "Stop!",
        messageId: "wamid.STOP-1",
      }),
    );
    await drain(A);
    const sup = await withTenant(app, A.tenantId, (tx) =>
      tx.suppressionRecord.findMany({
        where: { address: m.phone, liftedAt: null },
      }),
    );
    expect(sup).toHaveLength(1);
    const reply = (await outbound(A, { toPhone: m.phone, kind: "TEXT" }))[0];
    expect(reply).toMatchObject({ status: "SENT", purpose: "INBOX" });
    expect(reply!.body).toContain("START");
    const r = await sendTemplateToContact(deps, A.ctx, {
      templateId: offer.id,
      memberId: m.id,
      variables: {
        first_name: { source: "first_name" },
        gym: { source: "gym_name" },
      },
    });
    await drain(A);
    expect((await outbound(A, { id: r.id }))[0]).toMatchObject({
      status: "SKIPPED",
      skipReason: "SUPPRESSED",
    });
    await post(
      fakeWebhooks.inbound({
        wabaId: A.waba,
        phoneNumberId: A.number,
        from: m.phone.slice(1),
        text: "START",
        messageId: "wamid.START-1",
      }),
    );
    await drain(A);
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.suppressionRecord.count({
          where: { address: m.phone, liftedAt: null },
        }),
      ),
    ).toBe(0);
    const consent = await withTenant(app, A.tenantId, (tx) =>
      tx.contactConsent.findFirstOrThrow({
        where: { memberId: m.id, channel: "WHATSAPP", purpose: "MARKETING" },
        orderBy: { capturedAt: "desc" },
      }),
    );
    expect(consent).toMatchObject({
      status: "GRANTED",
      method: "INBOUND_KEYWORD",
    });
  });
});

describe("notifications on WhatsApp", () => {
  it("maps a built-in message to an approved UTILITY template (never MARKETING)", async () => {
    const offer = await tpl(A, "festive_offer");
    const due = await tpl(A, "payment_due_reminder");
    await expectCode(
      saveNotificationTemplate(deps, A.ctx, {
        key: "payment.received",
        templateId: offer.id,
        variables: { first_name: "name", gym: "gym" },
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      saveNotificationTemplate(deps, A.ctx, {
        key: "payment.received",
        templateId: due.id,
        variables: { "1": "name" },
      }),
      "VALIDATION_FAILED",
    );
    await saveNotificationTemplate(deps, A.ctx, {
      key: "payment.received",
      templateId: due.id,
      variables: { "1": "name", "2": "amount", "3": "gym", "4": "receipt" },
    });
    const m = await member(A);
    await activeMembership(A, m.id);
    await drain(A);
    const rows = await outbound(A, { memberId: m.id, purpose: "NOTIFICATION" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "SENT",
      templateName: "payment_due_reminder",
    });
    expect(rows[0]!.body).toContain("₹1,000.00");
  });
});

describe("campaigns", () => {
  it("segment → template → schedule → throttled send → statuses → attribution; STOP after scheduling still wins", async () => {
    const fans = [
      await member(A, { marketing: true, tags: ["m6camp"] }),
      await member(A, { marketing: true, tags: ["m6camp"] }),
      await member(A, { marketing: true, tags: ["m6camp"] }),
    ];
    const noConsent = await member(A, { tags: ["m6camp"] });
    const definition = {
      entity: "MEMBER",
      conditions: [{ field: "tags", op: "hasAny", value: ["m6camp"] }],
    };
    const preview = await previewSegment(deps, A.ctx, definition);
    expect(preview).toMatchObject({ count: 4, marketingReachable: 3 });
    expect(JSON.stringify(preview.sample)).not.toContain(
      fans[0]!.phone.slice(-8),
    );
    const seg = await saveSegment(deps, A.ctx, null, {
      name: "Campaign tag",
      definition,
    });
    const offer = await tpl(A, "festive_offer");
    const campaign = await saveCampaign(deps, A.ctx, null, {
      name: "Diwali WhatsApp",
      channel: "WHATSAPP",
      code: "diwali-wa",
    });
    // Launch needs marketing.send.
    const reception = await addStaff(A, "RECEPTIONIST");
    await expectCode(
      configureCampaignSend(deps, reception, campaign.id, {
        segmentId: seg.id,
        templateId: offer.id,
        variableMap: {},
      }),
      "FORBIDDEN",
    );
    await expectCode(
      configureCampaignSend(deps, A.ctx, campaign.id, {
        segmentId: seg.id,
        templateId: offer.id,
        variableMap: { first_name: { source: "first_name" } },
      }),
      "VALIDATION_FAILED",
    );
    await configureCampaignSend(deps, A.ctx, campaign.id, {
      segmentId: seg.id,
      templateId: offer.id,
      variableMap: {
        first_name: { source: "first_name" },
        gym: { source: "gym_name" },
      },
      throttlePerMinute: 2,
    });
    const est = await estimateCampaign(deps, A.ctx, campaign.id);
    expect(est).toMatchObject({
      recipients: 4,
      reachable: 3,
      category: "MARKETING",
    });
    expect(est.preview).toContain("Aqua");
    await testSendCampaign(deps, A.ctx, campaign.id, { phones: "9876500001" });
    const later = new Date(Date.now() + 2 * 3600_000);
    await launchCampaign(deps, A.ctx, campaign.id, {
      scheduledAt:
        todayIn("Asia/Kolkata", later) +
        "T" +
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Kolkata",
        }).format(later),
      confirmRecipients: est.recipients,
    });
    // Not due yet.
    expect(await dispatchCampaigns(deps, A.tenantId)).toMatchObject({
      started: 0,
    });
    // A recipient opts out after scheduling.
    await post(
      fakeWebhooks.inbound({
        wabaId: A.waba,
        phoneNumberId: A.number,
        from: fans[2]!.phone.slice(1),
        text: "unsubscribe",
        messageId: "wamid.STOP-CAMP",
      }),
    );
    await drain(A);
    const due = { ...deps, now: () => new Date(later.getTime() + 60_000) };
    expect(await dispatchCampaigns(due, A.tenantId)).toMatchObject({
      started: 1,
      queued: 2,
    });
    expect(await dispatchCampaigns(due, A.tenantId)).toMatchObject({
      queued: 2,
      completed: 1,
    });
    await drain(A, due);
    const stats = await campaignStats(deps, A.ctx, campaign.id);
    expect(stats).toMatchObject({ total: 4, sent: 2, optedOut: 1 });
    expect(stats.skipReasons).toEqual(
      expect.arrayContaining([
        { reason: "SUPPRESSED", count: 1 },
        { reason: "NO_MARKETING_CONSENT", count: 1 },
      ]),
    );
    const toStopped = await outbound(A, {
      toPhone: fans[2]!.phone,
      category: "MARKETING",
      status: { in: ["SENT", "DELIVERED", "READ"] },
    });
    expect(toStopped).toHaveLength(0);
    expect(noConsent).toBeDefined();
    // Status webhooks update the campaign's live stats.
    const msg = (
      await outbound(A, {
        campaignId: campaign.id,
        purpose: "CAMPAIGN",
        status: "SENT",
      })
    )[0]!;
    await post(
      fakeWebhooks.status({
        wabaId: A.waba,
        phoneNumberId: A.number,
        messageId: msg.providerMessageId!,
        status: "delivered",
      }),
    );
    await drain(A);
    expect((await campaignStats(deps, A.ctx, campaign.id)).delivered).toBe(1);
    // A recipient renews within the attribution window.
    await withTenant(app, A.tenantId, (tx) =>
      tx.outboundMessage.updateMany({
        where: {
          campaignId: campaign.id,
          purpose: "CAMPAIGN",
          status: { in: ["SENT", "DELIVERED"] },
        },
        data: { sentAt: new Date(Date.now() - 60_000) },
      }),
    );
    const renewer = (
      await withTenant(app, A.tenantId, (tx) =>
        tx.outboundMessage.findFirstOrThrow({
          where: {
            campaignId: campaign.id,
            purpose: "CAMPAIGN",
            status: { in: ["SENT", "DELIVERED"] },
          },
        }),
      )
    ).memberId!;
    await activeMembership(A, renewer);
    expect(
      (await campaignStats(deps, A.ctx, campaign.id)).attribution,
    ).toMatchObject({ sent: 2, renewals: 1, payers: 1 });
  });
});

describe("automation engine", () => {
  it("a duplicate trigger runs once; the expiry workflow queues the reminder once and waits", async () => {
    const m = await member(A);
    const ms = await activeMembership(A, m.id);
    const today = todayIn("Asia/Kolkata", new Date());
    await withTenant(app, A.tenantId, (tx) =>
      tx.membership.update({
        where: { id: ms.id },
        data: { endDate: toDbDate(addDays(today, 7)) },
      }),
    );
    const renewal = await tpl(A, "membership_renewal_reminder");
    const wf = await saveWorkflow(deps, A.ctx, null, {
      name: "Expiry 7d",
      definition: {
        trigger: { type: "membership.expiring", days: 7 },
        steps: [
          {
            type: "send_template",
            templateId: renewal.id,
            variables: {
              "1": { source: "first_name" },
              "2": { source: "plan_name" },
              "3": { source: "end_date" },
            },
          },
          { type: "wait", hours: 24 },
          { type: "owner_alert", message: "{{full_name}} hasn't renewed yet." },
        ],
        exitWhen: ["RENEWED"],
      },
    });
    const dry = await dryRunWorkflow(
      deps,
      A.ctx,
      (await getWorkflow(deps, A.ctx, wf.id)).definition,
    );
    expect(dry.wouldStart).toBeGreaterThanOrEqual(1);
    await setWorkflowEnabled(deps, A.ctx, wf.id, true);
    const scan = () =>
      withTenant(app, A.tenantId, (tx) =>
        runAutomationScansTx(tx, A.tenantId, today, new Date()),
      );
    expect(await scan()).toEqual({ started: 1 });
    expect(await scan()).toEqual({ started: 0 });
    await drain(A);
    const execs = await withTenant(app, A.tenantId, (tx) =>
      tx.automationExecution.findMany({ where: { workflowId: wf.id } }),
    );
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ status: "WAITING", nextStep: 1 });
    expect(await outbound(A, { executionId: execs[0]!.id })).toEqual([
      expect.objectContaining({ status: "SENT", purpose: "AUTOMATION" }),
    ]);
    // A new version doesn't start it again for the same trigger.
    await saveWorkflow(deps, A.ctx, wf.id, {
      name: "Expiry 7d",
      definition: (await getWorkflow(deps, A.ctx, wf.id)).definition,
    });
    expect(await scan()).toEqual({ started: 0 });
    // After the wait: the alert, then done.
    const later = { ...deps, now: () => new Date(Date.now() + 25 * 3600_000) };
    expect(
      await runExecution(later, A.tenantId, execs[0]!.id, {
        finalAttempt: false,
      }),
    ).toBe("COMPLETED");
    const steps = await withTenant(app, A.tenantId, (tx) =>
      tx.automationStepRun.findMany({
        where: { executionId: execs[0]!.id },
        orderBy: { stepIndex: "asc" },
      }),
    );
    expect(steps.map((s) => `${s.type}:${s.status}`)).toEqual([
      "send_template:DONE",
      "wait:DONE",
      "owner_alert:DONE",
    ]);
    // Same event delivered twice → one execution (EventConsumption + unique trigger key).
    const lead = await createLead(deps, A.ctx, {
      firstName: "Dup",
      phone: phoneOf(),
      branchId: A.branchId,
    });
    const wf2 = await saveWorkflow(deps, A.ctx, null, {
      name: "Lead alert",
      definition: {
        trigger: { type: "lead.created" },
        steps: [
          { type: "notify", to: "OWNERS", message: "New lead {{first_name}}" },
        ],
      },
    });
    await setWorkflowEnabled(deps, A.ctx, wf2.id, true);
    const ev = await owner.outbox.findFirstOrThrow({
      where: {
        tenantId: A.tenantId,
        topic: "event",
        payload: { path: ["data", "leadId"], equals: lead.id },
      },
    });
    const subject = {
      memberId: null,
      leadId: lead.id,
      branchId: A.branchId,
      planId: null,
      amountMinor: null,
      leadSourceId: null,
      context: {},
    };
    const twice = await withTenant(app, A.tenantId, async (tx) => [
      await startExecutionsTx(
        tx,
        A.tenantId,
        { type: "lead.created", key: `event:${ev.id}` },
        subject,
        new Date(),
      ),
      await startExecutionsTx(
        tx,
        A.tenantId,
        { type: "lead.created", key: `event:${ev.id}` },
        subject,
        new Date(),
      ),
    ]);
    expect(twice.map((t) => t.length)).toEqual([1, 0]);
    await dispatchEvent(app, A.tenantId, ev.id, [AUTOMATION_EVENT_HANDLER]);
    await dispatchEvent(app, A.tenantId, ev.id, [AUTOMATION_EVENT_HANDLER]);
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.automationExecution.count({ where: { workflowId: wf2.id } }),
      ),
    ).toBe(1);
  });

  it("an approval step blocks until someone with automations.approve decides", async () => {
    const wf = await saveWorkflow(deps, A.ctx, null, {
      name: "Approve then alert",
      definition: {
        trigger: { type: "trial.no_show" },
        steps: [
          { type: "approval", note: "Call them?" },
          {
            type: "create_task",
            title: "Call {{first_name}}",
            dueInHours: 2,
            assignTo: "UNASSIGNED",
          },
        ],
      },
    });
    await setWorkflowEnabled(deps, A.ctx, wf.id, true);
    const lead = await createLead(deps, A.ctx, {
      firstName: "Noshow",
      phone: phoneOf(),
      branchId: A.branchId,
    });
    const ev = await withTenant(app, A.tenantId, (tx) =>
      import("@gym/core/events").then(({ emitEvent }) =>
        emitEvent(tx, A.tenantId, "trial.no_show", {
          trialId: crypto.randomUUID(),
          leadId: lead.id,
        }),
      ),
    );
    await drain(A);
    const exec = await withTenant(app, A.tenantId, (tx) =>
      tx.automationExecution.findFirstOrThrow({
        where: { workflowId: wf.id, triggerKey: `event:${ev}` },
      }),
    );
    expect(exec.status).toBe("AWAITING_APPROVAL");
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.followUpTask.count({
          where: { leadId: lead.id, title: "Call Noshow" },
        }),
      ),
    ).toBe(0);
    // Running it again changes nothing while it waits.
    expect(
      await runExecution(deps, A.tenantId, exec.id, { finalAttempt: false }),
    ).toBe("NOOP");
    const reception = await addStaff(A, "RECEPTIONIST");
    await expectCode(
      decideApproval(deps, reception, exec.id, { approve: true }),
      "FORBIDDEN",
    );
    const otherBranchManager = await addStaff(
      A,
      "BRANCH_MANAGER",
      (
        await withTenant(app, A.tenantId, (tx) =>
          tx.branch.create({
            data: {
              tenantId: A.tenantId,
              name: "Aqua East",
              code: "EAST",
              stateCode: "08",
            },
          }),
        )
      ).id,
    );
    await expectCode(
      decideApproval(deps, otherBranchManager, exec.id, { approve: true }),
      "FORBIDDEN",
    );
    expect((await listApprovals(deps, A.ctx)).map((a) => a.id)).toContain(
      exec.id,
    );
    await decideApproval(deps, A.ctx, exec.id, { approve: true, note: "ok" });
    await drain(A);
    expect(
      (
        await withTenant(app, A.tenantId, (tx) =>
          tx.automationExecution.findUniqueOrThrow({ where: { id: exec.id } }),
        )
      ).status,
    ).toBe("COMPLETED");
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.followUpTask.count({
          where: { leadId: lead.id, title: "Call Noshow" },
        }),
      ),
    ).toBe(1);
    await expectCode(
      decideApproval(deps, A.ctx, exec.id, { approve: true }),
      "CONFLICT",
    );
  });

  it("installs the five ready-made workflows switched off", async () => {
    for (const key of [
      "expiry_reminders",
      "overdue_follow_up",
      "speed_to_lead",
      "trial_no_show",
      "win_back_30",
    ]) {
      const r = await installLibraryWorkflow(deps, A.ctx, key);
      expect(r.warnings).toEqual([]);
      const w = await getWorkflow(deps, A.ctx, r.id);
      expect(w.workflow.enabled).toBe(false);
    }
  });
});

describe("retention", () => {
  it("flags with the rule that fired, resolves on a visit and records the recovery", async () => {
    const m = await member(A);
    const ms = await activeMembership(A, m.id);
    const today = todayIn("Asia/Kolkata", new Date());
    await withTenant(app, A.tenantId, (tx) =>
      tx.membership.update({
        where: { id: ms.id },
        data: { startDate: toDbDate(addDays(today, -20)) },
      }),
    );
    const run = () =>
      withTenant(app, A.tenantId, (tx) =>
        runRetentionTx(tx, A.tenantId, today, new Date()),
      );
    await run();
    const dash = await retentionDashboard(deps, A.ctx, { kind: "NO_VISIT" });
    const flag = dash.rows.find((r) => r.memberId === m.id)!;
    expect(flag.reason).toMatch(/No visit since joining \(rule: 14 days\)/);
    expect(flag.recommended).toMatch(/Call/);
    await run(); // still one open flag
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.retentionFlag.count({ where: { memberId: m.id, kind: "NO_VISIT" } }),
      ),
    ).toBe(1);
    expect(
      await owner.outbox.count({
        where: {
          tenantId: A.tenantId,
          topic: "event",
          payload: { path: ["data", "flagId"], equals: flag.id },
        },
      }),
    ).toBe(1);
    await withTenant(app, A.tenantId, (tx) =>
      tx.attendanceEvent.create({
        data: {
          tenantId: A.tenantId,
          branchId: A.branchId,
          memberId: m.id,
          method: "MANUAL",
          result: "ACCEPTED",
        },
      }),
    );
    await run();
    const after = await withTenant(app, A.tenantId, (tx) =>
      tx.retentionFlag.findUniqueOrThrow({
        where: { id: flag.id },
        include: { outcomes: true },
      }),
    );
    expect(after).toMatchObject({
      status: "RESOLVED",
      outcome: "Visited again",
    });
    expect(after.outcomes).toEqual([
      expect.objectContaining({ kind: "REACTIVATED" }),
    ]);
    expect(
      (await retentionDashboard(deps, A.ctx)).recovery.reactivated,
    ).toBeGreaterThanOrEqual(1);
    // B never sees A's flags.
    expect((await retentionDashboard(deps, B.ctx)).rows).toHaveLength(0);
  });
});
