import type { AuthContext } from "@gym/core/authz";
import { recordPayment } from "@gym/core/billing";
import { createSecretBox } from "@gym/core/crypto";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import { gstinCheckChar } from "@gym/core/gst";
import {
  acceptPrivacyNotice,
  completeDeletion,
  createMember,
  exportMyData,
  getMyPrivacy,
  requestMyDeletion,
  resolveMemberContext,
  type MemberContext,
} from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import {
  approveRefund,
  buyPlanOnline,
  connectPaymentIntegration,
  getPaymentForRefund,
  getPaymentIntegration,
  getReconciliation,
  myPaymentStatus,
  onlinePaymentsEnabled,
  payMyBalance,
  processWebhookEvent,
  receiveWebhook,
  reconcileTenant,
  requestRefund,
  resolveReconciliationItem,
  sendPaymentLink,
  updatePaymentPolicies,
} from "@gym/core/payments";
import type { PlatformContext } from "@gym/core/platform";
import { createPlan } from "@gym/core/plans";
import {
  applySubscriptionState,
  getBillingSettings,
  updateBillingSettings,
  changeMySubscription,
  getMyBilling,
  processPlatformWebhook,
  receivePlatformWebhook,
  runBillingLifecycle,
  setPlatformPaymentAccount,
  startCheckout,
  verifyInternalRequest,
  type BillingDeps,
} from "@gym/core/saas-billing";
import {
  createTenantForOwner,
  loadTenantAccess,
  type CoreDeps,
} from "@gym/core/tenancy";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import {
  FakePaymentProvider,
  FakeSubscriptionProvider,
  memoryFakeStore,
  signWebhook,
  type FakeWebhook,
} from "@gym/integrations/payments";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsFor } from "../src/permissions";

let db: TestDatabase;
let app: PrismaClient;
let owner: PrismaClient;
let platformDb: PrismaClient;
let deps: CoreDeps;
const store = memoryFakeStore();
const box = createSecretBox({
  key: "m4-integration-test-kek-0123456789abcdef",
});

type Gym = {
  tenantId: string;
  branchId: string;
  ctx: AuthContext;
  integrationId: string;
  webhookSecret: string;
  fake: FakePaymentProvider;
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

async function addStaff(
  gym: Pick<Gym, "tenantId">,
  roleKey: string,
  email: string,
) {
  const user = await app.user.create({
    data: { email, name: roleKey, emailVerified: true },
  });
  await withTenant(app, gym.tenantId, async (tx) => {
    const m = await tx.tenantMembership.create({
      data: { tenantId: gym.tenantId, userId: user.id },
    });
    await tx.roleAssignment.create({
      data: {
        tenantId: gym.tenantId,
        membershipId: m.id,
        roleKey,
        branchId: null,
      },
    });
  });
  return ctxFor(user.id, gym.tenantId);
}

async function makeGym(name: string): Promise<Gym> {
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
  await owner.$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'pro') WHERE tenant_id = ${tenantId}::uuid`;
  const branchId = await withTenant(
    app,
    tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const ctx = await ctxFor(user.id, tenantId);
  const keyId = `fake_${name.toLowerCase()}_key`;
  const webhookSecret = `whsec_${name.toLowerCase()}_0123456789`;
  const { id } = await connectPaymentIntegration(
    deps,
    ctx,
    {
      provider: "FAKE",
      mode: "TEST",
      keyId,
      keySecret: "fake-secret-123",
      webhookSecret,
    },
    { allowFake: true },
  );
  return {
    tenantId,
    branchId,
    ctx,
    integrationId: id,
    webhookSecret,
    fake: new FakePaymentProvider(store, keyId, "fake-secret-123"),
  };
}

/** Delivers a webhook the way Razorpay would; returns the HTTP status our endpoint answers. */
async function deliver(
  gym: Pick<Gym, "integrationId" | "webhookSecret" | "tenantId">,
  w: FakeWebhook,
  opts: { secret?: string; integrationId?: string } = {},
) {
  const r = await receiveWebhook(deps, {
    integrationId: opts.integrationId ?? gym.integrationId,
    rawBody: w.rawBody,
    signature: signWebhook(w.rawBody, opts.secret ?? gym.webhookSecret),
    eventIdHeader: w.eventId,
  });
  if (r.status === 200 && r.webhookEventId)
    await processWebhookEvent(deps, r.tenantId, r.webhookEventId);
  return r;
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

let A: Gym;
let B: Gym;
let plan: { id: string };
let n = 0;

/** A member with an unpaid ₹1,000 membership invoice (and an app account). */
async function memberWithInvoice(gym: Gym) {
  n++;
  const m = await createMember(deps, gym.ctx, {
    firstName: `Pay${n}`,
    phone: `97${String(20_000_000 + n)}`,
    homeBranchId: gym.branchId,
    email: `pay${n}@x.test`,
  });
  const sale = await sellMembership(deps, gym.ctx, {
    memberId: m.id,
    planId: plan.id,
  });
  const user = await app.user.create({
    data: { email: `payapp${n}@x.test`, name: `Pay ${n}`, emailVerified: true },
  });
  await withTenant(app, gym.tenantId, (tx) =>
    tx.memberProfile.update({ where: { id: m.id }, data: { userId: user.id } }),
  );
  const mctx = (await resolveMemberContext(
    app,
    user.id,
    gym.tenantId,
  )) as MemberContext;
  return {
    member: m,
    invoice: sale.invoice,
    membership: sale.membership,
    mctx,
  };
}

const count = (gym: Gym, memberId: string) =>
  withTenant(app, gym.tenantId, (tx) =>
    tx.gymPayment.count({ where: { memberId } }),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  platformDb = createPrismaClient(db.platformUrl);
  deps = {
    db: app,
    entitlements: noEntitlementCache,
    secrets: box,
    appUrl: "http://localhost:3000",
    payments: (acct) =>
      new FakePaymentProvider(store, acct.keyId, acct.keySecret),
  };
  A = await makeGym("Alpha");
  B = await makeGym("Beta");
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
  await owner.$executeRaw`UPDATE app.membership_plan SET online_purchase = true WHERE id = ${plan.id}::uuid`;
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await platformDb?.$disconnect();
  await db?.drop();
});

describe("gym payment account", () => {
  it("stores secrets sealed and shows only the last 4", async () => {
    const view = await getPaymentIntegration(deps, A.ctx);
    expect(view).toMatchObject({
      provider: "FAKE",
      mode: "TEST",
      secretLast4: "-123",
    });
    expect(JSON.stringify(view)).not.toContain("fake-secret-123");
    const row = await withTenant(app, A.tenantId, (tx) =>
      tx.paymentIntegration.findFirstOrThrow({ where: { status: "ACTIVE" } }),
    );
    expect(row.keySecretEnc).not.toContain("fake-secret");
    expect(row.webhookSecretEnc).not.toContain("whsec");
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: "payment_integration.connected" },
      }),
    );
    expect(JSON.stringify(audit)).not.toContain("fake-secret-123");
    // Receptionists can't connect accounts.
    const desk = await addStaff(A, "RECEPTIONIST", "desk-pay@alpha.test");
    await expectCode(
      connectPaymentIntegration(
        deps,
        desk,
        {
          provider: "FAKE",
          mode: "TEST",
          keyId: "x_key_123",
          keySecret: "abcdefgh",
          webhookSecret: "abcdefgh",
        },
        { allowFake: true },
      ),
      "FORBIDDEN",
    );
    // Wrong credentials are refused before anything is stored.
    await expectCode(
      connectPaymentIntegration(
        deps,
        A.ctx,
        {
          provider: "FAKE",
          mode: "TEST",
          keyId: "fake_bad_key",
          keySecret: "wrong-secret",
          webhookSecret: "abcdefgh",
        },
        { allowFake: true },
      ),
      "VALIDATION_FAILED",
    );
  });
});

describe("webhooks (fake provider)", () => {
  it("rejects a forged signature and writes nothing", async () => {
    const { mctx, member } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    const { webhook } = await A.fake.pay(link.providerLinkId!);
    const before = await withTenant(app, A.tenantId, (tx) =>
      tx.webhookEvent.count(),
    );
    const r = await deliver(A, webhook, { secret: "attacker-secret-xyz" });
    expect(r).toMatchObject({ status: 400 });
    expect(
      await withTenant(app, A.tenantId, (tx) => tx.webhookEvent.count()),
    ).toBe(before);
    expect(await count(A, member.id)).toBe(0);
    // A tampered body with a valid-looking signature from the old body is also refused.
    const tampered = {
      ...webhook,
      rawBody: webhook.rawBody.replace('"amount":100000', '"amount":1'),
    };
    const t = await receiveWebhook(deps, {
      integrationId: A.integrationId,
      rawBody: tampered.rawBody,
      signature: signWebhook(webhook.rawBody, A.webhookSecret),
      eventIdHeader: webhook.eventId,
    });
    expect(t.status).toBe(400);
  });

  it("the same event delivered 3 times records one payment and activates the membership", async () => {
    const { mctx, member, membership } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    const { webhook } = await A.fake.pay(link.providerLinkId!);
    const results = [
      await deliver(A, webhook),
      await deliver(A, webhook),
      await deliver(A, webhook),
    ];
    expect(results.map((r) => r.status === 200 && r.duplicate)).toEqual([
      false,
      true,
      true,
    ]);
    expect(await count(A, member.id)).toBe(1);
    const state = await withTenant(app, A.tenantId, async (tx) => ({
      membership: await tx.membership.findUniqueOrThrow({
        where: { id: membership.id },
      }),
      link: await tx.paymentLink.findUniqueOrThrow({ where: { id: link.id } }),
      payment: await tx.gymPayment.findFirstOrThrow({
        where: { memberId: member.id },
      }),
    }));
    expect(state.membership.status).toBe("ACTIVE");
    expect(state.link.status).toBe("PAID");
    expect(state.payment).toMatchObject({
      method: "ONLINE",
      providerPaymentId: expect.stringMatching(/^pay_fake/),
    });
    // The member's return page reports what we recorded.
    expect((await myPaymentStatus(deps, mctx, link.id)).status).toBe("PAID");
  });

  it("partial then remainder (delivered out of order) → invoice PAID and membership ACTIVE", async () => {
    const { member, invoice, membership } = await memberWithInvoice(A);
    const link = await sendPaymentLink(deps, A.ctx, {
      invoiceIds: [invoice.id],
      acceptPartial: "on",
      minPartial: "200",
    });
    expect(link).toMatchObject({ acceptPartial: true });
    const first = await A.fake.pay(link.providerLinkId!, 40_000);
    const second = await A.fake.pay(link.providerLinkId!);
    // "paid" arrives before "partially_paid".
    await deliver(A, second.webhook);
    await deliver(A, first.webhook);
    const state = await withTenant(app, A.tenantId, async (tx) => ({
      invoice: await tx.gymInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      }),
      membership: await tx.membership.findUniqueOrThrow({
        where: { id: membership.id },
      }),
      link: await tx.paymentLink.findUniqueOrThrow({ where: { id: link.id } }),
      payments: await tx.gymPayment.findMany({
        where: { memberId: member.id },
        orderBy: { receivedAt: "asc" },
      }),
    }));
    expect(state.invoice.status).toBe("PAID");
    expect(state.membership.status).toBe("ACTIVE");
    expect(state.link).toMatchObject({
      status: "PAID",
      amountPaidMinor: 100000n,
    });
    expect(state.payments.map((p) => Number(p.amountMinor)).sort()).toEqual([
      40000, 60000,
    ]);
  });

  it("a missing webhook is fixed by reconciliation", async () => {
    const { mctx, member } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    await A.fake.pay(link.providerLinkId!); // webhook never delivered
    expect(await count(A, member.id)).toBe(0);
    const run = await reconcileTenant(deps, A.tenantId, {
      kind: "QUICK",
      olderThanMinutes: 0,
    });
    expect(run.fixed).toBeGreaterThanOrEqual(1);
    expect(await count(A, member.id)).toBe(1);
    // Running it again changes nothing.
    await reconcileTenant(deps, A.tenantId, {
      kind: "QUICK",
      olderThanMinutes: 0,
    });
    expect(await count(A, member.id)).toBe(1);
  });

  it("an online payment above what's now due becomes member credit", async () => {
    const { member, invoice, mctx } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    // Meanwhile the member also paid ₹400 cash at the desk.
    await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 40_000,
      allocations: [{ invoiceId: invoice.id, amountMinor: 40_000 }],
    });
    const { webhook } = await A.fake.pay(link.providerLinkId!); // pays the full ₹1,000 online
    await deliver(A, webhook);
    const credit = await withTenant(app, A.tenantId, (tx) =>
      tx.memberCreditEntry.aggregate({
        where: { memberId: member.id },
        _sum: { amountMinor: true },
      }),
    );
    expect(Number(credit._sum.amountMinor)).toBe(40_000);
  });

  it("tenant B's integration can't process tenant A's events", async () => {
    const { mctx, member } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    const { webhook } = await A.fake.pay(link.providerLinkId!);
    // Posted to B's endpoint, signed with A's secret: refused (B's secret differs).
    expect(
      (await deliver(B, webhook, { secret: A.webhookSecret })).status,
    ).toBe(400);
    // Even signed with B's own secret, the link isn't B's: ignored, nothing recorded anywhere.
    const r = await deliver(B, webhook);
    expect(r.status).toBe(200);
    expect(await count(A, member.id)).toBe(0);
    const ev = await withTenant(app, B.tenantId, (tx) =>
      tx.webhookEvent.findFirstOrThrow({ where: { eventId: webhook.eventId } }),
    );
    expect(ev.status).toBe("IGNORED");
  });
});

describe("member online purchases and refunds", () => {
  it("member buys a plan in the app: pending membership → paid link → active", async () => {
    n++;
    const m = await createMember(deps, A.ctx, {
      firstName: `Buyer${n}`,
      phone: `96${String(30_000_000 + n)}`,
      homeBranchId: A.branchId,
      email: `buy${n}@x.test`,
    });
    const user = await app.user.create({
      data: { email: `buyapp${n}@x.test`, name: "Buyer", emailVerified: true },
    });
    await withTenant(app, A.tenantId, (tx) =>
      tx.memberProfile.update({
        where: { id: m.id },
        data: { userId: user.id },
      }),
    );
    const mctx = (await resolveMemberContext(app, user.id, A.tenantId))!;
    const link = await buyPlanOnline(deps, mctx, plan.id);
    expect(link.purpose).toBe("PURCHASE");
    const pending = await withTenant(app, A.tenantId, (tx) =>
      tx.membership.findFirstOrThrow({ where: { memberId: m.id } }),
    );
    expect(pending.status).toBe("PENDING_PAYMENT");
    await deliver(A, (await A.fake.pay(link.providerLinkId!)).webhook);
    const active = await withTenant(app, A.tenantId, (tx) =>
      tx.membership.findUniqueOrThrow({ where: { id: pending.id } }),
    );
    expect(active.status).toBe("ACTIVE");
  });

  it("refund: credit note, provider refund, webhook processed once; big refunds need a second person", async () => {
    const { mctx, member } = await memberWithInvoice(A);
    const link = await payMyBalance(deps, mctx, {});
    await deliver(A, (await A.fake.pay(link.providerLinkId!)).webhook);
    const payment = await withTenant(app, A.tenantId, (tx) =>
      tx.gymPayment.findFirstOrThrow({ where: { memberId: member.id } }),
    );
    await updatePaymentPolicies(deps, A.ctx, {
      paymentLinkExpiryDays: "7",
      onlinePartialAllowed: "on",
      onlineMinPartial: "500",
      refundApprovalThreshold: "500",
      duesReminderDays: "1,7",
    });
    const accountant = await addStaff(A, "ACCOUNTANT", `acct${n}@alpha.test`);
    const asked = await requestRefund(deps, A.ctx, {
      paymentId: payment.id,
      amount: "600",
      reason: "Moved to another city",
    });
    expect(asked.executed).toBe(false); // above ₹500: waits for approval
    await expectCode(approveRefund(deps, A.ctx, asked.refund.id), "FORBIDDEN"); // not by the requester
    const done = await approveRefund(deps, accountant, asked.refund.id);
    expect(done).toMatchObject({
      status: "PENDING",
      providerRefundId: expect.stringMatching(/^rfnd_fake/),
    });
    const notes = await withTenant(app, A.tenantId, (tx) =>
      tx.creditNote.findMany({ where: { invoice: { memberId: member.id } } }),
    );
    expect(notes.map((x) => Number(x.totalMinor))).toEqual([60_000]);
    const settled = await A.fake.settleRefund(
      done.providerRefundId!,
      "processed",
    );
    await deliver(A, settled);
    await deliver(A, { ...settled, eventId: `${settled.eventId}-again` }); // a second, distinct delivery
    const row = await withTenant(app, A.tenantId, (tx) =>
      tx.refund.findUniqueOrThrow({ where: { id: done.id } }),
    );
    expect(row.status).toBe("PROCESSED");
    const notices = await withTenant(app, A.tenantId, (tx) =>
      tx.notification.count({
        where: { templateKey: "refund.processed", memberId: member.id },
      }),
    );
    expect(notices).toBeGreaterThanOrEqual(1);
    const credit = await withTenant(app, A.tenantId, (tx) =>
      tx.memberCreditEntry.aggregate({
        where: { memberId: member.id },
        _sum: { amountMinor: true },
      }),
    );
    expect(Number(credit._sum.amountMinor ?? 0)).toBe(0); // credit note in, refund out
    await updatePaymentPolicies(deps, A.ctx, {
      paymentLinkExpiryDays: "7",
      onlinePartialAllowed: "on",
      onlineMinPartial: "500",
      refundApprovalThreshold: "",
      duesReminderDays: "1,7",
    });
  });

  it("a manual payment is refunded by hand with a credit note", async () => {
    const { member, invoice } = await memberWithInvoice(A);
    const pay = await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 100_000,
      allocations: [{ invoiceId: invoice.id, amountMinor: 100_000 }],
    });
    await expectCode(
      requestRefund(deps, A.ctx, {
        paymentId: pay.payment.id,
        amount: "200",
        reason: "Charged twice by mistake",
      }),
      "VALIDATION_FAILED",
    ); // method missing
    const r = await requestRefund(deps, A.ctx, {
      paymentId: pay.payment.id,
      amount: "200",
      reason: "Charged twice by mistake",
      method: "CASH",
    });
    expect(r.refund).toMatchObject({ status: "PROCESSED", kind: "MANUAL" });
    await expectCode(
      requestRefund(deps, A.ctx, {
        paymentId: pay.payment.id,
        amount: "900",
        reason: "Too much now",
        method: "CASH",
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("SaaS subscription billing (platform)", () => {
  let billing: BillingDeps;
  let pctx: PlatformContext;
  const subsStore = memoryFakeStore();
  const sent: { to: string; subject: string }[] = [];
  let clock = new Date();

  beforeAll(async () => {
    const admin = await platformDb.platformUser.create({
      data: { email: "ops@platform.test", name: "Ops", role: "SUPER_ADMIN" },
    });
    pctx = {
      platformUserId: admin.id,
      role: "SUPER_ADMIN",
      permissions: new Set([
        "platform.billing.view",
        "platform.billing.manage",
      ]),
    };
    billing = {
      db: platformDb,
      entitlements: noEntitlementCache,
      secrets: box,
      subscriptions: () => new FakeSubscriptionProvider(subsStore),
      mailer: async (m) => {
        sent.push({ to: m.to, subject: m.subject });
      },
      appUrl: "http://localhost:3000",
      allowFake: true,
      now: () => clock,
    };
    await setPlatformPaymentAccount(billing, pctx, {
      provider: "FAKE",
      mode: "TEST",
      keyId: "fake_platform",
      keySecret: "platform-secret",
      webhookSecret: "whsec_platform_123",
    });
  });

  const deliverPlatform = async (ws: FakeWebhook[]) => {
    for (const w of ws) {
      const r = await receivePlatformWebhook(billing, {
        rawBody: w.rawBody,
        signature: signWebhook(w.rawBody, "whsec_platform_123"),
        eventIdHeader: w.eventId,
      });
      if (r.status === 200 && r.eventRowId)
        await processPlatformWebhook(billing, r.eventRowId);
    }
  };
  const subOf = (tenantId: string) =>
    platformDb.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });

  it("checkout → charged → ACTIVE with a SaaS invoice; duplicates record one payment", async () => {
    const price = await platformDb.saasPlanPrice.findFirstOrThrow({
      where: { cycle: "MONTHLY", plan: { code: "growth" } },
    });
    const out = await startCheckout(billing, {
      tenantId: B.tenantId,
      priceId: price.id,
      requestedByUserId: B.ctx.userId,
    });
    expect(out).toMatchObject({
      kind: "checkout",
      url: expect.stringContaining("/dev/fake-subscribe/"),
    });
    // A redirect proves nothing: still trialing until the verified webhook.
    expect((await subOf(B.tenantId)).status).toBe("TRIALING");
    const sub = await subOf(B.tenantId);
    const events = await new FakeSubscriptionProvider(subsStore).simulate(
      sub.providerSubscriptionId!,
      "charge",
    );
    await deliverPlatform(events);
    await deliverPlatform(events); // duplicates
    const after = await subOf(B.tenantId);
    expect(after).toMatchObject({
      status: "ACTIVE",
      priceId: price.id,
      pendingPriceId: null,
    });
    expect(
      await platformDb.platformPayment.count({
        where: { tenantId: B.tenantId },
      }),
    ).toBe(1);
    const invoice = await platformDb.platformInvoice.findFirstOrThrow({
      where: { tenantId: B.tenantId },
    });
    expect(invoice.number).toMatch(/^SAAS\/\d{2}-\d{2}\/00001$/);
    expect(Number(invoice.totalMinor)).toBe(Number(price.amountMinor));
    // The gym can see its own SaaS invoice, not another gym's.
    const seen = await withTenant(app, B.tenantId, (tx) =>
      tx.platformInvoice.count(),
    );
    const notSeen = await withTenant(app, A.tenantId, (tx) =>
      tx.platformInvoice.count(),
    );
    expect([seen, notSeen]).toEqual([1, 0]);
  });

  it("payment failure → PAST_DUE → GRACE → SUSPENDED (one email per stage), then recovery", async () => {
    const sub = await subOf(B.tenantId);
    const fake = new FakeSubscriptionProvider(subsStore);
    await deliverPlatform(
      await fake.simulate(sub.providerSubscriptionId!, "fail"),
    );
    expect((await subOf(B.tenantId)).status).toBe("PAST_DUE");
    await deliverPlatform(
      await fake.simulate(sub.providerSubscriptionId!, "halt"),
    );
    const grace = await subOf(B.tenantId);
    expect(grace.status).toBe("GRACE");
    expect(grace.graceEndsAt).not.toBeNull();
    await runBillingLifecycle(billing);
    expect((await subOf(B.tenantId)).status).toBe("GRACE"); // not yet
    clock = new Date(grace.graceEndsAt!.getTime() + 60_000);
    await runBillingLifecycle(billing);
    await runBillingLifecycle(billing);
    expect((await subOf(B.tenantId)).status).toBe("SUSPENDED");
    const stages = sent.map((s) => s.subject);
    expect(stages.filter((s) => s.includes("payment failed"))).toHaveLength(1);
    expect(stages.filter((s) => s.includes("action needed"))).toHaveLength(1);
    expect(stages.filter((s) => s.includes("read-only"))).toHaveLength(1);
    // Paying again restores it.
    await deliverPlatform(
      await fake.simulate(sub.providerSubscriptionId!, "charge"),
    );
    expect((await subOf(B.tenantId)).status).toBe("ACTIVE");
    clock = new Date();
  });

  it("platform webhooks run on gym_platform, which can't touch gym tables", async () => {
    await expect(
      platformDb.$executeRaw`SELECT count(*) FROM app.gym_payment`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      platformDb.$executeRaw`INSERT INTO app.audit_log (id, tenant_id, actor_type, action, entity_type) VALUES (gen_random_uuid(), ${A.tenantId}::uuid, 'SYSTEM', 'x', 'x')`,
    ).rejects.toThrow(/permission denied/);
    // A forged platform webhook is refused and stored nowhere.
    const before = await platformDb.platformWebhookEvent.count();
    const r = await receivePlatformWebhook(billing, {
      rawBody: '{"event":"subscription.charged","payload":{}}',
      signature: "0".repeat(64),
      eventIdHeader: "evt_forged",
    });
    expect(r.status).toBe(400);
    expect(await platformDb.platformWebhookEvent.count()).toBe(before);
    // An unknown subscription changes nothing.
    expect(
      await applySubscriptionState(
        billing,
        {
          id: "sub_unknown",
          planId: "x",
          status: "active",
          currentStart: null,
          currentEnd: null,
          chargeAt: null,
          paidCount: 1,
          notes: {},
        },
        null,
      ),
    ).toBe("unknown");
  });
  it("supplier GSTIN: invalid ones are refused; once set, SaaS invoices split CGST/SGST", async () => {
    const base = {
      legalName: "Fonix Technologies",
      stateCode: "08",
      address: "Jaipur",
      graceDays: "7",
      sacCode: "998315",
      taxRatePercent: "18",
    };
    await expectCode(
      updateBillingSettings(billing, pctx, {
        ...base,
        gstin: "08AAAAA0000A1Z0",
      }),
      "VALIDATION_FAILED",
    );
    const gstin = `08AAKFF1234M1Z${gstinCheckChar("08AAKFF1234M1Z")}`;
    await expectCode(
      updateBillingSettings(billing, pctx, { ...base, stateCode: "27", gstin }),
      "VALIDATION_FAILED",
    ); // state mismatch
    await updateBillingSettings(billing, pctx, { ...base, gstin });
    expect((await getBillingSettings(billing, pctx)).supplier.gstin).toBe(
      gstin,
    );
    const sub = await subOf(B.tenantId);
    await deliverPlatform(
      await new FakeSubscriptionProvider(subsStore).simulate(
        sub.providerSubscriptionId!,
        "charge",
      ),
    );
    const latest = await platformDb.platformInvoice.findFirstOrThrow({
      where: { tenantId: B.tenantId },
      orderBy: { number: "desc" },
    });
    expect(Number(latest.cgstMinor)).toBeGreaterThan(0);
    // An odd paisa of tax goes to one half (same rule as gym invoices).
    expect(
      Math.abs(Number(latest.cgstMinor) - Number(latest.sgstMinor)),
    ).toBeLessThanOrEqual(1);
    expect(
      Number(latest.taxableMinor + latest.cgstMinor + latest.sgstMinor),
    ).toBe(Number(latest.totalMinor)); // GST-inclusive price
    expect((latest.supplier as { gstin: string }).gstin).toBe(gstin);
    await updateBillingSettings(billing, pctx, { ...base, gstin: "" });
  });
});

describe("M4 screens: refund form, reconciliation, owner billing, privacy", () => {
  it("the refund form shows what can still be refunded; front desk can't open it", async () => {
    const { member, invoice } = await memberWithInvoice(A);
    const pay = await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "UPI",
      reference: "UPI-REF-1",
      amountMinor: 100_000,
      allocations: [{ invoiceId: invoice.id, amountMinor: 100_000 }],
    });
    await requestRefund(deps, A.ctx, {
      paymentId: pay.payment.id,
      amount: "250",
      reason: "Goodwill for closure",
      method: "UPI",
      reference: "UPI-OUT-1",
    });
    const view = await getPaymentForRefund(deps, A.ctx, pay.payment.id);
    expect(view).toMatchObject({
      amountMinor: 100_000,
      refundableMinor: 75_000,
      online: false,
      hasMembership: true,
    });
    expect(view.refunds).toHaveLength(1);
    const desk = await addStaff(A, "FRONT_DESK", `desk-refund${n}@alpha.test`);
    await expectCode(
      getPaymentForRefund(deps, desk, pay.payment.id),
      "FORBIDDEN",
    );
    // Another gym's payment id finds nothing.
    await expectCode(
      getPaymentForRefund(deps, B.ctx, pay.payment.id),
      "NOT_FOUND",
    );
  });

  it("reconciliation items are listed and resolved with an audit note", async () => {
    const run = await reconcileTenant(deps, A.tenantId, {
      kind: "MANUAL",
      olderThanMinutes: 0,
    });
    const item = await withTenant(app, A.tenantId, (tx) =>
      tx.reconciliationItem.create({
        data: {
          tenantId: A.tenantId,
          runId: run.runId,
          entity: "LINK",
          entityId: A.integrationId,
          issue: "Test mismatch",
        },
      }),
    );
    const view = await getReconciliation(deps, A.ctx);
    expect(view.open.map((i) => i.id)).toContain(item.id);
    expect(view.runs[0]?.id).toBe(run.runId);
    const desk = await addStaff(A, "FRONT_DESK", `desk-recon${n}@alpha.test`);
    await expectCode(
      resolveReconciliationItem(deps, desk, item.id, { note: "Checked" }),
      "FORBIDDEN",
    );
    await expectCode(
      resolveReconciliationItem(deps, A.ctx, item.id, { note: "" }),
      "VALIDATION_FAILED",
    );
    await resolveReconciliationItem(deps, A.ctx, item.id, {
      note: "Matched by hand in Razorpay",
    });
    expect(
      (await getReconciliation(deps, A.ctx)).open.map((i) => i.id),
    ).not.toContain(item.id);
    expect(
      (await getReconciliation(deps, B.ctx)).runs.map((r) => r.id),
    ).not.toContain(run.runId);
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findFirst({
        where: { action: "reconciliation.item_resolved", entityId: item.id },
      }),
    );
    expect(audit).not.toBeNull();
  });

  it("owner billing: only subscription.manage sends a signed request to the admin app", async () => {
    const secret = "internal-test-secret-0123456789abcdef";
    const calls: {
      path: string;
      ok: boolean;
      body: Record<string, unknown>;
    }[] = [];
    const transport = {
      adminUrl: "http://admin.test",
      secret,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = String(init?.body ?? "");
        const h = new Headers(init?.headers);
        calls.push({
          path,
          ok: verifyInternalRequest(secret, path, body, {
            timestamp: h.get("x-internal-timestamp"),
            signature: h.get("x-internal-signature"),
          }),
          body: JSON.parse(body),
        });
        return Response.json({
          kind: "checkout",
          url: "http://admin.test/dev/fake-subscribe/sub_x",
        });
      }) as typeof fetch,
    };
    const price = await withTenant(app, A.tenantId, (tx) =>
      tx.saasPlanPrice.findFirstOrThrow({ where: { cycle: "MONTHLY" } }),
    );
    const desk = await addStaff(A, "FRONT_DESK", `desk-billing${n}@alpha.test`);
    await expectCode(
      changeMySubscription(deps, desk, { priceId: price.id }, transport),
      "FORBIDDEN",
    );
    expect(calls).toHaveLength(0);
    const out = await changeMySubscription(
      deps,
      A.ctx,
      { priceId: price.id },
      transport,
    );
    expect(out).toMatchObject({ kind: "checkout" });
    expect(calls).toEqual([
      {
        path: "/api/internal/billing/checkout",
        ok: true,
        body: { tenantId: A.tenantId, userId: A.ctx.userId, priceId: price.id },
      },
    ]);
    // Works while suspended too: paying is the way out of read-only.
    const suspended = { ...A.ctx, subscriptionStatus: "SUSPENDED" as const };
    await changeMySubscription(
      deps,
      suspended,
      { priceId: price.id },
      transport,
    );
    expect(calls).toHaveLength(2);
    // The owner sees prices and their own invoices only.
    const mine = await getMyBilling(deps, A.ctx);
    expect(mine.prices.length).toBeGreaterThan(0);
    expect(mine.invoices).toHaveLength(0);
  });

  it("privacy: notice, export, deletion request → staff anonymise; app access ends", async () => {
    const { member, mctx } = await memberWithInvoice(A);
    // App access for this member (MEMBER role), as an invite acceptance would create.
    await withTenant(app, A.tenantId, async (tx) => {
      const m = await tx.tenantMembership.create({
        data: { tenantId: A.tenantId, userId: mctx.userId },
      });
      await tx.roleAssignment.create({
        data: {
          tenantId: A.tenantId,
          membershipId: m.id,
          roleKey: "MEMBER",
          branchId: A.branchId,
        },
      });
    });
    expect((await getMyPrivacy(deps, mctx)).accepted).toBe(false);
    await acceptPrivacyNotice(deps, mctx);
    expect((await getMyPrivacy(deps, mctx)).accepted).toBe(true);
    const data = await exportMyData(deps, mctx);
    expect(data.profile).toMatchObject({ memberCode: member.memberCode });
    expect(data.invoices).toHaveLength(1);
    const first = await requestMyDeletion(deps, mctx, { note: "Leaving town" });
    const again = await requestMyDeletion(deps, mctx, {});
    expect(again.id).toBe(first.id);
    const desk = await addStaff(A, "FRONT_DESK", `desk-privacy${n}@alpha.test`);
    await expectCode(completeDeletion(deps, desk, first.id), "FORBIDDEN");
    await expectCode(completeDeletion(deps, B.ctx, first.id), "NOT_FOUND");
    await completeDeletion(deps, A.ctx, first.id);
    const after = await withTenant(app, A.tenantId, (tx) =>
      tx.memberProfile.findUniqueOrThrow({ where: { id: member.id } }),
    );
    expect(after).toMatchObject({
      firstName: "Deleted",
      email: null,
      phone: null,
      userId: null,
    });
    expect(after.anonymizedAt).not.toBeNull();
    // Financial records stay.
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.gymInvoice.count({ where: { memberId: member.id } }),
      ),
    ).toBe(1);
    // The member can no longer open this gym in the app.
    expect(await resolveMemberContext(app, mctx.userId, A.tenantId)).toBeNull();
    await expectCode(completeDeletion(deps, A.ctx, first.id), "CONFLICT");
  });
});

describe("plan feature: online payments", () => {
  it("a plan without online payments gets 402 for links and the member sees no Pay button", async () => {
    const { mctx, invoice } = await memberWithInvoice(A);
    await owner.$executeRaw`INSERT INTO platform.subscription_override (id, tenant_id, feature_key, value, reason) VALUES (gen_random_uuid(), ${A.tenantId}::uuid, 'online_payments.enabled', 'false'::jsonb, 'test')`;
    try {
      await expectCode(
        sendPaymentLink(deps, A.ctx, { invoiceIds: [invoice.id] }),
        "ENTITLEMENT_REQUIRED",
      );
      await expectCode(payMyBalance(deps, mctx, {}), "ENTITLEMENT_REQUIRED");
      expect((await onlinePaymentsEnabled(deps, mctx)).enabled).toBe(false);
    } finally {
      await owner.$executeRaw`DELETE FROM platform.subscription_override WHERE tenant_id = ${A.tenantId}::uuid AND feature_key = 'online_payments.enabled'`;
    }
    expect((await onlinePaymentsEnabled(deps, mctx)).enabled).toBe(true);
  });
});
