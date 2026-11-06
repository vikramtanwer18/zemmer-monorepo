import { upsertPlatformUser } from "@gym/auth/platform";
import { upsertPasswordUser } from "@gym/auth/tenant";
import { noEntitlementCache } from "@gym/core/entitlements";
import { createTenantForOwner } from "@gym/core/tenancy";
import { createPrismaClient, type PrismaClient } from "@gym/db";
import {
  clearRateLimits,
  otpCode,
  testEmail,
  testPassword,
  waitForEmail,
} from "@gym/testing/e2e";
import { expect, type Page } from "@playwright/test";

// Fixtures go straight into the development database (as the runtime roles), with unique
// throwaway emails so runs never collide.

let appDb: PrismaClient | undefined;
let platformDb: PrismaClient | undefined;

function app() {
  appDb ??= createPrismaClient(process.env.DATABASE_URL!, {
    maxConnections: 2,
  });
  return appDb;
}
function platform() {
  platformDb ??= createPrismaClient(process.env.PLATFORM_DATABASE_URL!, {
    maxConnections: 2,
  });
  return platformDb;
}

export async function createOwnerWithGym(name = "E2E Owner") {
  const email = testEmail("owner");
  const password = testPassword();
  const user = await upsertPasswordUser(app(), { email, name, password });
  const gym = await createTenantForOwner(
    { db: app(), entitlements: noEntitlementCache },
    { userId: user.id },
    {
      gymName: `E2E Gym ${Date.now()}`,
      stateCode: "08",
      branchName: "E2E Main",
    },
  );
  return { email, password, name, tenantId: gym.tenantId };
}

export async function createPlatformAdmin() {
  const email = testEmail("ops");
  const password = testPassword();
  await upsertPlatformUser(platform(), {
    email,
    name: "E2E Ops",
    password,
    role: "SUPER_ADMIN",
  });
  return { email, password };
}

/** Emailed links use APP_URL; this keeps only the path so tests stay on the server under test. */
export function onServer(link: string): string {
  const url = new URL(link);
  return url.pathname + url.search;
}

/**
 * The whole suite signs in from one IP, more often than the per-IP limits allow in 15 minutes.
 * Clear the dev counters first (as the global setup does); the limits themselves are tested in
 * auth.int.test.ts.
 */
export async function signIn(page: Page, email: string, password: string) {
  await clearRateLimits();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** On /verify: asks for a code, reads it from Mailpit and submits it. */
export async function passOtp(page: Page, email: string) {
  await clearRateLimits();
  await expect(
    page.getByRole("heading", { name: "Check it's you" }),
  ).toBeVisible();
  const sentAfter = new Date(Date.now() - 1000);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(
    page.getByText("We've emailed you a 6-digit code"),
  ).toBeVisible();
  const mail = await waitForEmail(email, {
    subject: /sign-in code/,
    after: sentAfter,
  });
  await page.getByLabel("6-digit code").fill(otpCode(mail.text));
  await page.getByRole("button", { name: "Verify" }).click();
}

/**
 * M3: a gym on the Pro plan (classes and PT on), one plan with unlimited classes, and members
 * with app accounts and a paid, active membership. Built through the core services.
 */
export async function createFloorGym(memberNames: string[]) {
  const { authContextFor } = await import("@gym/auth/context");
  const { createMember, grantMemberAppAccess } =
    await import("@gym/core/members");
  const { sellMembership } = await import("@gym/core/memberships");
  const { createPlan } = await import("@gym/core/plans");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym();
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'pro' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${owner.tenantId}::uuid`;
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = { db: app(), entitlements: noEntitlementCache };
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const plan = await createPlan(deps, ctx, {
    name: "E2E Classes",
    price: "1000",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
    classCredits: "unlimited",
  });
  const members = [];
  for (const [i, name] of memberNames.entries()) {
    const email = testEmail(`m${i}`);
    const password = testPassword();
    const user = await upsertPasswordUser(app(), { email, name, password });
    const member = await createMember(deps, ctx, {
      firstName: name,
      email,
      phone: `97${String(Date.now() + i).slice(-8)}`,
      homeBranchId: branchId,
    });
    await withTenant(app(), owner.tenantId, async (tx) => {
      // An onboarded member: has seen the privacy notice (M4 onboarding gate).
      const { PRIVACY_NOTICE_VERSION } = await import("@gym/core/members");
      await tx.memberProfile.update({
        where: { id: member.id },
        data: {
          userId: user.id,
          privacyAcceptedAt: new Date(),
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        },
      });
      await grantMemberAppAccess(
        tx,
        owner.tenantId,
        member.id,
        user.id,
        branchId,
      );
    });
    await sellMembership(deps, ctx, {
      memberId: member.id,
      planId: plan.id,
      payment: { method: "CASH", amountMinor: 100_000 },
    });
    members.push({ email, password, name, memberId: member.id });
  }
  return { owner, members, branchId };
}

/**
 * M4: a gym connected to the TEST payment provider, and a member (app account, privacy notice
 * accepted) with an unpaid ₹1,500 membership invoice.
 */
export async function createPaymentsGym() {
  const { authContextFor } = await import("@gym/auth/context");
  const { createMember, grantMemberAppAccess, PRIVACY_NOTICE_VERSION } =
    await import("@gym/core/members");
  const { sellMembership } = await import("@gym/core/memberships");
  const { createPlan } = await import("@gym/core/plans");
  const { connectPaymentIntegration } = await import("@gym/core/payments");
  const { createSecretBox } = await import("@gym/core/crypto");
  const { memoryFakeStore, paymentProviderFactory } =
    await import("@gym/integrations/payments");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym();
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = {
    db: app(),
    entitlements: noEntitlementCache,
    secrets: createSecretBox({ key: process.env.DATA_ENCRYPTION_KEY! }),
    // Only checks the credentials; the server under test keeps links in Redis.
    payments: paymentProviderFactory({
      fakeEnabled: true,
      store: memoryFakeStore(),
    }),
  };
  await connectPaymentIntegration(
    deps,
    ctx,
    {
      provider: "FAKE",
      mode: "TEST",
      keyId: `fake_e2e_${Date.now()}`,
      keySecret: "e2e-key-secret",
      webhookSecret: "e2e-webhook-secret",
    },
    { allowFake: true },
  );
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const plan = await createPlan(deps, ctx, {
    name: "E2E Monthly",
    price: "1500",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
  });
  const email = testEmail("payer");
  const password = testPassword();
  const user = await upsertPasswordUser(app(), {
    email,
    name: "Payal Payer",
    password,
  });
  const member = await createMember(deps, ctx, {
    firstName: "Payal",
    email,
    phone: `96${String(Date.now()).slice(-8)}`,
    homeBranchId: branchId,
  });
  await withTenant(app(), owner.tenantId, async (tx) => {
    await tx.memberProfile.update({
      where: { id: member.id },
      data: {
        userId: user.id,
        privacyAcceptedAt: new Date(),
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      },
    });
    await grantMemberAppAccess(
      tx,
      owner.tenantId,
      member.id,
      user.id,
      branchId,
    );
  });
  const sale = await sellMembership(deps, ctx, {
    memberId: member.id,
    planId: plan.id,
  });
  return {
    owner,
    member: { email, password, memberId: member.id },
    invoiceId: sale.invoice!.id,
  };
}

/**
 * The platform's TEST payment account for SaaS billing. Returns false (and changes nothing) when a
 * real Razorpay account is already set: tests never replace it.
 */
export async function ensureFakePlatformAccount() {
  const { setPlatformPaymentAccount } = await import("@gym/core/saas-billing");
  const { createSecretBox } = await import("@gym/core/crypto");
  const { memoryFakeStore, subscriptionProviderFactory } =
    await import("@gym/integrations/payments");
  const current = await platform().platformPaymentAccount.findFirst({
    where: { active: true },
  });
  if (current) return current.provider === "FAKE";
  const admin = await createPlatformAdmin();
  const row = await platform().platformUser.findUniqueOrThrow({
    where: { email: admin.email.toLowerCase() },
  });
  await setPlatformPaymentAccount(
    {
      db: platform(),
      entitlements: noEntitlementCache,
      secrets: createSecretBox({ key: process.env.DATA_ENCRYPTION_KEY! }),
      allowFake: true,
      subscriptions: subscriptionProviderFactory({
        fakeEnabled: true,
        store: memoryFakeStore(),
      }),
    },
    {
      platformUserId: row.id,
      role: "SUPER_ADMIN",
      permissions: new Set([
        "platform.billing.manage",
        "platform.billing.view",
      ]),
    },
    {
      provider: "FAKE",
      mode: "TEST",
      keyId: "fake_e2e_platform",
      keySecret: "e2e-platform-secret",
      webhookSecret: "e2e-platform-webhook",
    },
  );
  return true;
}

/** The newest payment link's checkout URL for a gym. */
export async function latestLinkUrl(tenantId: string) {
  const { withTenant } = await import("@gym/db");
  const link = await withTenant(app(), tenantId, (tx) =>
    tx.paymentLink.findFirstOrThrow({ orderBy: { createdAt: "desc" } }),
  );
  return link.shortUrl!;
}

/** Sets the gym's subscription state directly (what verified webhooks would do). */
export async function setSubscriptionState(
  tenantId: string,
  status: "PAST_DUE" | "GRACE" | "SUSPENDED" | "ACTIVE",
) {
  const graceEndsAt =
    status === "GRACE" ? new Date(Date.now() + 3 * 86_400_000) : null;
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET status = ${status}::platform."SubscriptionStatus", grace_ends_at = ${graceEndsAt} WHERE tenant_id = ${tenantId}::uuid`;
}

/**
 * M5: a gym on the Growth plan (CRM on) with a membership plan, a campaign, a website capture
 * form (embeddable from https://www.example-gym.test) and an API key.
 */
export async function createCrmGym() {
  const { authContextFor } = await import("@gym/auth/context");
  const { createPlan } = await import("@gym/core/plans");
  const { createApiKey, saveCampaign, saveCaptureForm } =
    await import("@gym/core/crm");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym();
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'growth' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${owner.tenantId}::uuid`;
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = { db: app(), entitlements: noEntitlementCache };
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const tenant = await platform().tenant.findUniqueOrThrow({
    where: { id: owner.tenantId },
  });
  await createPlan(deps, ctx, {
    name: "E2E Monthly",
    price: "2000",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
  });
  const code = `e2e-${Date.now()}`;
  const campaign = await saveCampaign(deps, ctx, null, {
    name: "E2E Instagram",
    channel: "INSTAGRAM",
    code,
  });
  const form = await saveCaptureForm(deps, ctx, null, {
    name: "Website",
    branchId,
    title: "Book your free trial",
    fields: ["email", "interest"],
    consentText: "I agree that {gym} may contact me about my enquiry.",
    thankYou: "Thanks! We'll call you soon.",
    embedOrigins: "https://www.example-gym.test",
  });
  const { key } = await createApiKey(deps, ctx, { name: "Website", branchId });
  return {
    owner,
    slug: tenant.slug,
    formKey: form.key,
    campaign: { ...campaign, code },
    apiKey: key,
  };
}

/** Member app sign-in. */
export async function memberSignIn(
  page: Page,
  email: string,
  password: string,
) {
  await clearRateLimits();
  await page.goto("/m/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/m\/$/);
}

/** M6: a Growth-plan gym with a plan and members tagged for a campaign (marketing consent given). */
export async function createGrowthGym() {
  const { authContextFor } = await import("@gym/auth/context");
  const { createPlan } = await import("@gym/core/plans");
  const { createMember } = await import("@gym/core/members");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym();
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'growth' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${owner.tenantId}::uuid`;
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = await growthDeps();
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const plan = await createPlan(deps, ctx, {
    name: "E2E Monthly",
    price: "1200",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
  });
  const tag = `camp${Date.now()}`;
  const stamp = String(Date.now()).slice(-7);
  const members = [];
  for (const [i, name] of ["Asha", "Bina"].entries()) {
    const m = await createMember(deps, ctx, {
      firstName: name,
      phone: `9${i + 1}${stamp}0`,
      homeBranchId: branchId,
      marketingWhatsapp: "on",
    });
    await withTenant(app(), owner.tenantId, (tx) =>
      tx.memberProfile.update({ where: { id: m.id }, data: { tags: [tag] } }),
    );
    members.push({ id: m.id, name });
  }
  const tail = `${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  return {
    owner,
    ctx,
    tenantId: owner.tenantId,
    planId: plan.id,
    branchId,
    tag,
    members,
    waba: `7${tail}`,
    phoneNumberId: `8${tail}`,
  };
}

async function growthDeps() {
  const { createSecretBox } = await import("@gym/core/crypto");
  const { whatsappClientFactory } = await import("@gym/integrations/whatsapp");
  const { memoryFakeStore } = await import("@gym/integrations/payments");
  return {
    db: app(),
    entitlements: noEntitlementCache,
    secrets: createSecretBox({ key: process.env.DATA_ENCRYPTION_KEY! }),
    whatsapp: whatsappClientFactory({
      fakeEnabled: true,
      store: memoryFakeStore(),
    }),
  };
}

/**
 * Plays the worker for one gym: campaign batches, then everything the outbox holds for it
 * (sends, webhook items, automation runs, events). All of it is idempotent, so a real worker
 * running at the same time does no harm.
 */
export async function runGrowthWorker(tenantId: string, rounds = 6) {
  const { dispatchCampaigns } = await import("@gym/core/growth");
  const { deliverMessage, processMessageEvent, RetryableSendError } =
    await import("@gym/core/messaging");
  const { AUTOMATION_EVENT_HANDLER, runExecution } =
    await import("@gym/core/automation");
  const { dispatchEvent } = await import("@gym/core/events");
  const { withTenant } = await import("@gym/db");
  const deps = await growthDeps();
  const done = new Set<string>();
  await dispatchCampaigns(deps, tenantId);
  for (let r = 0; r < rounds; r++) {
    const rows = await withTenant(app(), tenantId, (tx) =>
      tx.outbox.findMany({
        where: {
          topic: {
            in: ["message.send", "message.event", "automation.run", "event"],
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
    const todo = rows.filter((x) => !done.has(x.id));
    if (!todo.length) return;
    for (const row of todo) {
      done.add(row.id);
      const p = row.payload as Record<string, string>;
      if (row.topic === "message.send")
        await deliverMessage(deps, tenantId, p.outboundId!, {
          finalAttempt: true,
        }).catch((e: unknown) => {
          if (!(e instanceof RetryableSendError)) throw e;
        });
      else if (row.topic === "message.event")
        await processMessageEvent(deps, tenantId, p.messageEventId!, {
          finalAttempt: true,
        });
      else if (row.topic === "automation.run")
        await runExecution(deps, tenantId, p.executionId!, {
          finalAttempt: true,
        });
      else
        await dispatchEvent(app(), tenantId, row.id, [
          AUTOMATION_EVENT_HANDLER,
        ]);
    }
  }
}

/** A member renews/buys and pays at the desk (for attribution). */
export async function payMembership(
  ctx: import("@gym/core/authz").AuthContext,
  memberId: string,
  planId: string,
) {
  const { sellMembership } = await import("@gym/core/memberships");
  const { recordPayment } = await import("@gym/core/billing");
  const deps = await growthDeps();
  const sale = await sellMembership(deps, ctx, { memberId, planId });
  const total = Number(sale.invoice.totalMinor);
  await recordPayment(deps, ctx, {
    memberId,
    method: "CASH",
    amountMinor: total,
    allocations: [{ invoiceId: sale.invoice.id, amountMinor: total }],
  });
  return sale.membership.id;
}

/** Sets a membership to end N days from today (tenant timezone). */
export async function endMembershipIn(
  tenantId: string,
  membershipId: string,
  days: number,
) {
  const { addDays, todayIn, toDbDate } = await import("@gym/core/time/dates");
  const { withTenant } = await import("@gym/db");
  await withTenant(app(), tenantId, (tx) =>
    tx.membership.update({
      where: { id: membershipId },
      data: {
        endDate: toDbDate(addDays(todayIn("Asia/Kolkata", new Date()), days)),
      },
    }),
  );
}

export async function runScans(tenantId: string) {
  const { runAutomationScansTx } = await import("@gym/core/automation");
  const { todayIn } = await import("@gym/core/time/dates");
  const { withTenant } = await import("@gym/db");
  return withTenant(app(), tenantId, (tx) =>
    runAutomationScansTx(
      tx,
      tenantId,
      todayIn("Asia/Kolkata", new Date()),
      new Date(),
    ),
  );
}

export async function growthRows(tenantId: string) {
  const { withTenant } = await import("@gym/db");
  return withTenant(app(), tenantId, async (tx) => ({
    outbound: await tx.outboundMessage.findMany({
      orderBy: { queuedAt: "asc" },
    }),
    executions: await tx.automationExecution.findMany(),
  }));
}

/**
 * M7: a Pro gym with a trainer (password sign-in; trainers don't need the email code by default),
 * a member assigned to that trainer and a referrer member, both with app accounts.
 */
export async function createFitnessGym() {
  const { authContextFor } = await import("@gym/auth/context");
  const { createMember, grantMemberAppAccess, PRIVACY_NOTICE_VERSION } =
    await import("@gym/core/members");
  const { sellMembership } = await import("@gym/core/memberships");
  const { createPlan } = await import("@gym/core/plans");
  const { assignTrainer, upsertTrainerProfile } =
    await import("@gym/core/staff");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym();
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'pro' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${owner.tenantId}::uuid`;
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = { db: app(), entitlements: noEntitlementCache };
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const plan = await createPlan(deps, ctx, {
    name: "E2E Monthly",
    price: "1200",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
  });
  const trainerEmail = testEmail("trainer");
  const trainerPassword = testPassword();
  const trainerUser = await upsertPasswordUser(app(), {
    email: trainerEmail,
    name: "Coach Meera",
    password: trainerPassword,
  });
  await withTenant(app(), owner.tenantId, async (tx) => {
    const m = await tx.tenantMembership.create({
      data: { tenantId: owner.tenantId, userId: trainerUser.id },
    });
    await tx.roleAssignment.create({
      data: {
        tenantId: owner.tenantId,
        membershipId: m.id,
        roleKey: "TRAINER",
        branchId: null,
      },
    });
  });
  const trainerProfile = await upsertTrainerProfile(deps, ctx, trainerUser.id, {
    displayName: "Coach Meera",
    specialties: "Strength",
    visibleToMembers: "on",
  });
  const members = [];
  for (const [i, name] of ["Arjun", "Riya"].entries()) {
    const email = testEmail(`fit${i}`);
    const password = testPassword();
    const user = await upsertPasswordUser(app(), { email, name, password });
    const member = await createMember(deps, ctx, {
      firstName: name,
      email,
      phone: `95${String(Date.now() + i).slice(-8)}`,
      homeBranchId: branchId,
    });
    await withTenant(app(), owner.tenantId, async (tx) => {
      await tx.memberProfile.update({
        where: { id: member.id },
        data: {
          userId: user.id,
          privacyAcceptedAt: new Date(),
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        },
      });
      await grantMemberAppAccess(
        tx,
        owner.tenantId,
        member.id,
        user.id,
        branchId,
      );
    });
    await sellMembership(deps, ctx, {
      memberId: member.id,
      planId: plan.id,
      payment: { method: "CASH", amountMinor: 120_000 },
    });
    members.push({ email, password, name, memberId: member.id });
  }
  await assignTrainer(deps, ctx, {
    memberId: members[0]!.memberId,
    trainerId: trainerProfile.id,
  });
  const tenant = await platform().tenant.findUniqueOrThrow({
    where: { id: owner.tenantId },
  });
  return {
    owner,
    ctx,
    tenantId: owner.tenantId,
    slug: tenant.slug,
    planId: plan.id,
    trainer: { email: trainerEmail, password: trainerPassword },
    member: members[0]!,
    referrer: members[1]!,
  };
}

/** The friend joins (lead → member → paid membership) and the engagement handler runs (worker's job). */
export async function friendJoinsAndPays(
  ctx: import("@gym/core/authz").AuthContext,
  tenantId: string,
  phoneDigits: string,
  planId: string,
) {
  const { convertLead } = await import("@gym/core/crm");
  const { sellMembership } = await import("@gym/core/memberships");
  const { recordPayment } = await import("@gym/core/billing");
  const { ENGAGEMENT_EVENT_HANDLER } = await import("@gym/core/engagement");
  const { dispatchEvent } = await import("@gym/core/events");
  const { withTenant } = await import("@gym/db");
  const deps = { db: app(), entitlements: noEntitlementCache };
  const lead = await withTenant(app(), tenantId, (tx) =>
    tx.lead.findFirstOrThrow({ where: { phone: `+91${phoneDigits}` } }),
  );
  const { memberId } = await convertLead(deps, ctx, lead.id, {});
  const sale = await sellMembership(deps, ctx, {
    memberId,
    planId,
    leadId: lead.id,
  });
  const total = Number(sale.invoice!.totalMinor);
  await recordPayment(deps, ctx, {
    memberId,
    method: "CASH",
    amountMinor: total,
    allocations: [{ invoiceId: sale.invoice!.id, amountMinor: total }],
  });
  const events = await withTenant(app(), tenantId, (tx) =>
    tx.outbox.findMany({
      where: {
        topic: "event",
        payload: { path: ["type"], equals: "lead.converted" },
      },
    }),
  );
  for (const e of events)
    await dispatchEvent(app(), tenantId, e.id, [ENGAGEMENT_EVENT_HANDLER]);
}

/**
 * M8: a Pro gym (Copilot included) with three paid members: two whose membership ends within the
 * week (3 and 5 days) and one in 20 days. Names are unique per run.
 */
export async function createIntelligenceGym() {
  const { authContextFor } = await import("@gym/auth/context");
  const { createMember } = await import("@gym/core/members");
  const { createPlan } = await import("@gym/core/plans");
  const { withTenant } = await import("@gym/db");
  const owner = await createOwnerWithGym("Intel Owner");
  await platform()
    .$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'pro' AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1) WHERE tenant_id = ${owner.tenantId}::uuid`;
  const ownerUser = await app().user.findUniqueOrThrow({
    where: { email: owner.email },
  });
  const ctx = (await authContextFor(app(), ownerUser.id, owner.tenantId))!;
  const deps = { db: app(), entitlements: noEntitlementCache };
  const branchId = await withTenant(
    app(),
    owner.tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  const plan = await createPlan(deps, ctx, {
    name: "E2E Monthly",
    price: "1500",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "0",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    refundRule: "NONE",
  });
  const tag = String(Date.now()).slice(-5);
  const people = [
    { name: `Kavya${tag}`, days: 3 },
    { name: `Rohan${tag}`, days: 5 },
    { name: `Later${tag}`, days: 20 },
  ];
  for (const [i, p] of people.entries()) {
    const member = await createMember(deps, ctx, {
      firstName: p.name,
      phone: `93${String(Date.now() + i).slice(-8)}`,
      homeBranchId: branchId,
    });
    const membershipId = await payMembership(ctx, member.id, plan.id);
    await endMembershipIn(owner.tenantId, membershipId, p.days);
  }
  return {
    owner,
    expiring: people.filter((p) => p.days <= 7).map((p) => p.name),
    later: people.find((p) => p.days > 7)!.name,
  };
}
