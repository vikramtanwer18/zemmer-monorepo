import type { AuthContext } from "@gym/core/authz";
import {
  apiCreateLead,
  archiveStage,
  assignLead,
  attributionReport,
  bookTrial,
  convertLead,
  createApiKey,
  createLead,
  createStage,
  crmTick,
  ensureCrmDefaults,
  getCrmSetup,
  getLead,
  listLeads,
  logLeadActivity,
  markLeadLost,
  markTrial,
  moveLead,
  pipelineBoard,
  publicFormView,
  reorderStages,
  revokeApiKey,
  saveCampaign,
  saveCaptureForm,
  scanTrialPass,
  submitPublicForm,
  updateCrmSettings,
} from "@gym/core/crm";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import { dispatchEvent, type EventHandler } from "@gym/core/events";
import { sellMembership } from "@gym/core/memberships";
import { createPlan } from "@gym/core/plans";
import {
  startOfDayUtc,
  todayIn,
  utcToLocalDateTime,
} from "@gym/core/time/dates";
import {
  createTenantForOwner,
  loadTenantAccess,
  type CoreDeps,
} from "@gym/core/tenancy";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsFor } from "../src/permissions";

let db: TestDatabase;
let app: PrismaClient;
let owner: PrismaClient;
let deps: CoreDeps;

type Gym = {
  tenantId: string;
  slug: string;
  branchId: string;
  ctx: AuthContext;
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
  return {
    tenantId,
    slug: tenant.slug,
    branchId,
    ctx: await ctxFor(user.id, tenantId),
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

const events = (gym: Gym, type: string) =>
  owner.outbox.findMany({
    where: {
      tenantId: gym.tenantId,
      topic: "event",
      payload: { path: ["type"], equals: type },
    },
  });

let A: Gym;
let B: Gym;
let phoneSeq = 50_000_000;
const phone = () => `98${++phoneSeq}`;
/** A datetime-local value in the gym timezone (as the form sends it). */
const localAt = (ms: number) =>
  utcToLocalDateTime(new Date(ms), "Asia/Kolkata");

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  deps = {
    db: app,
    entitlements: noEntitlementCache,
    appUrl: "http://localhost:3000",
  };
  A = await makeGym("Apex");
  B = await makeGym("Bolt");
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

describe("pipeline stages", () => {
  it("custom stages map to categories; funnel order and the last stage of a category are protected", async () => {
    const setup = await getCrmSetup(deps, A.ctx);
    expect(setup.stages.map((s) => s.category)).toEqual([
      "NEW",
      "CONTACTED",
      "TRIAL_SCHEDULED",
      "TRIAL_ATTENDED",
      "OFFER_SENT",
      "WON",
      "LOST",
    ]);
    const hot = await createStage(deps, A.ctx, {
      name: "Hot — call today",
      category: "CONTACTED",
    });
    const after = await getCrmSetup(deps, A.ctx);
    expect(after.stages.findIndex((s) => s.id === hot.id)).toBe(2); // right after Contacted
    const ids = after.stages.map((s) => s.id);
    await expectCode(
      reorderStages(deps, A.ctx, { ids: [ids[1], ids[0], ...ids.slice(2)] }),
      "VALIDATION_FAILED",
    );
    const newStage = after.stages.find((s) => s.category === "NEW")!;
    await expectCode(archiveStage(deps, A.ctx, newStage.id, {}), "CONFLICT");
    // A stage with leads needs a same-kind target.
    const lead = await createLead(deps, A.ctx, {
      firstName: "Hot",
      phone: phone(),
      branchId: A.branchId,
    });
    await moveLead(deps, A.ctx, lead.id, { stageId: hot.id });
    await expectCode(
      archiveStage(deps, A.ctx, hot.id, {}),
      "VALIDATION_FAILED",
    );
    await expectCode(
      archiveStage(deps, A.ctx, hot.id, { moveTo: newStage.id }),
      "VALIDATION_FAILED",
    );
    const contacted = after.stages.find(
      (s) => s.category === "CONTACTED" && s.id !== hot.id,
    )!;
    await archiveStage(deps, A.ctx, hot.id, { moveTo: contacted.id });
    expect((await getLead(deps, A.ctx, lead.id)).stage.id).toBe(contacted.id);
    // Won only via a paid membership; Lost needs a reason.
    const won = after.stages.find((s) => s.category === "WON")!;
    await expectCode(
      moveLead(deps, A.ctx, lead.id, { stageId: won.id }),
      "VALIDATION_FAILED",
    );
  });

  it("CRM needs the plan feature (starter has none) — 402 before 403", async () => {
    const S = await makeGym("Starty", "starter");
    const desk = await addStaff(S, "TRAINER");
    await expectCode(listLeads(deps, desk, {}), "ENTITLEMENT_REQUIRED");
    await expectCode(listLeads(deps, S.ctx, {}), "ENTITLEMENT_REQUIRED");
  });
});

describe("lead entry, duplicates, assignment", () => {
  it("warns about duplicates against leads and members; 'add anyway' works", async () => {
    const p = phone();
    await createLead(deps, A.ctx, {
      firstName: "Dup",
      phone: p,
      branchId: A.branchId,
    });
    const err = await expectCode(
      createLead(deps, A.ctx, {
        firstName: "Dup2",
        phone: p,
        branchId: A.branchId,
      }),
      "CONFLICT",
    );
    expect(
      (err.details as { duplicates: { leads: unknown[] } }).duplicates.leads,
    ).toHaveLength(1);
    await createLead(deps, A.ctx, {
      firstName: "Dup2",
      phone: p,
      branchId: A.branchId,
      confirmDuplicate: "on",
    });
    // Another gym's leads never count as duplicates.
    await createLead(deps, B.ctx, {
      firstName: "Elsewhere",
      phone: p,
      branchId: B.branchId,
    });
  });

  it("round-robin is fair among sales staff, even when leads arrive together", async () => {
    const R = await makeGym("Rotor");
    const team = [
      await addStaff(R, "SALES_STAFF", R.branchId),
      await addStaff(R, "SALES_STAFF", R.branchId),
      await addStaff(R, "SALES_STAFF"),
    ];
    await addStaff(R, "RECEPTIONIST", R.branchId); // not in the rotation
    await updateCrmSettings(deps, R.ctx, {
      leadAssignment: "ROUND_ROBIN",
      leadFirstContactMinutes: "15",
      taskReminderMinutes: "30",
    });
    const form = await saveCaptureForm(deps, R.ctx, null, {
      name: "Site",
      branchId: R.branchId,
      title: "Join us",
      fields: ["email"],
      consentText: "I agree that {gym} may contact me about my enquiry.",
      thankYou: "Thanks!",
    });
    await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        submitPublicForm(deps, {
          tenantSlug: R.slug,
          key: form.key,
          body: { firstName: `RR${i}`, phone: phone(), consent: "on" },
        }),
      ),
    );
    const leads = await withTenant(app, R.tenantId, (tx) => tx.lead.findMany());
    const counts = new Map<string, number>();
    for (const l of leads)
      counts.set(l.ownerUserId!, (counts.get(l.ownerUserId!) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(team.map((t) => t.userId).sort());
    expect([...counts.values()]).toEqual([3, 3, 3]);
    // Their first-contact tasks are theirs.
    const tasks = await withTenant(app, R.tenantId, (tx) =>
      tx.followUpTask.findMany({ where: { kind: "FIRST_CONTACT" } }),
    );
    expect(
      tasks.every((t) => team.some((m) => m.userId === t.assigneeUserId)),
    ).toBe(true);
  });

  it("assignment: sales staff may claim an unowned lead but not give it away; managers can", async () => {
    const sales = await addStaff(A, "SALES_STAFF", A.branchId);
    const other = await addStaff(A, "SALES_STAFF", A.branchId);
    const lead = await createLead(deps, A.ctx, {
      firstName: "Claim",
      phone: phone(),
      branchId: A.branchId,
    });
    await assignLead(deps, sales, lead.id, { ownerUserId: sales.userId });
    await expectCode(
      assignLead(deps, sales, lead.id, { ownerUserId: other.userId }),
      "FORBIDDEN",
    );
    await assignLead(deps, A.ctx, lead.id, { ownerUserId: other.userId });
    const detail = await getLead(deps, A.ctx, lead.id);
    expect(detail.owner?.userId).toBe(other.userId);
    expect(
      detail.tasks.find((t) => t.kind === "FIRST_CONTACT")?.assigneeUserId,
    ).toBe(other.userId);
    expect((await events(A, "lead.assigned")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("public capture and API (tenant-safe, abuse-resistant)", () => {
  it("form → lead with UTM, source, campaign and consent; honeypot and repeats create nothing new", async () => {
    const campaign = await saveCampaign(deps, A.ctx, null, {
      name: "Diwali",
      channel: "INSTAGRAM",
      code: "diwali-2026",
    });
    const form = await saveCaptureForm(deps, A.ctx, null, {
      name: "Website",
      branchId: A.branchId,
      title: "Book a free trial",
      fields: ["email", "interest"],
      consentText: "I agree that {gym} may contact me about my enquiry.",
      marketingText: "Send me offers",
      thankYou: "We'll call you soon.",
    });
    const p = phone();
    const body = {
      firstName: "Utm",
      phone: p,
      email: "utm@x.in",
      interest: "Weight loss",
      consent: "on",
      marketing: "on",
      utm_source: "ig",
      utm_medium: "paid",
      utm_campaign: "DIWALI-2026",
      referrer: "https://instagram.com",
      tenantId: B.tenantId,
      branchId: B.branchId,
    };
    const res = await submitPublicForm(deps, {
      tenantSlug: A.slug,
      key: form.key,
      body,
    });
    expect(res).toEqual({ ok: true, thankYou: "We'll call you soon." });
    const lead = await withTenant(app, A.tenantId, (tx) =>
      tx.lead.findFirstOrThrow({
        where: { phone: `+91${p}` },
        include: { source: true },
      }),
    );
    expect(lead).toMatchObject({
      branchId: A.branchId,
      utmSource: "ig",
      utmCampaign: "DIWALI-2026",
      campaignId: campaign.id,
      marketingConsent: true,
      captureFormId: form.id,
    });
    expect(lead.source?.code).toBe("instagram");
    expect(lead.consentText).toContain("Apex");
    // Nothing landed in gym B, whatever the body said.
    expect(
      await withTenant(app, B.tenantId, (tx) =>
        tx.lead.count({ where: { phone: `+91${p}` } }),
      ),
    ).toBe(0);
    // Repeat enquiry: merged, last touch moves, first touch stays.
    await submitPublicForm(deps, {
      tenantSlug: A.slug,
      key: form.key,
      body: { ...body, utm_campaign: "summer" },
    });
    const again = await withTenant(app, A.tenantId, (tx) =>
      tx.lead.findMany({ where: { phone: `+91${p}` } }),
    );
    expect(again).toHaveLength(1);
    expect(
      (again[0]!.firstTouch as { utm: { campaign: string } }).utm.campaign,
    ).toBe("DIWALI-2026");
    expect(
      (again[0]!.lastTouch as { utm: { campaign: string } }).utm.campaign,
    ).toBe("summer");
    // Honeypot: looks fine, stores nothing.
    const before = await withTenant(app, A.tenantId, (tx) => tx.lead.count());
    expect(
      (
        await submitPublicForm(deps, {
          tenantSlug: A.slug,
          key: form.key,
          honeypot: "http://spam",
          body: { firstName: "Bot", phone: phone(), consent: "on" },
        })
      ).ok,
    ).toBe(true);
    expect(await withTenant(app, A.tenantId, (tx) => tx.lead.count())).toBe(
      before,
    );
    // Consent is required.
    await expectCode(
      submitPublicForm(deps, {
        tenantSlug: A.slug,
        key: form.key,
        body: { firstName: "NoConsent", phone: phone() },
      }),
      "VALIDATION_FAILED",
    );
    // A's form key under B's slug: not found.
    expect(
      await submitPublicForm(deps, { tenantSlug: B.slug, key: form.key, body }),
    ).toEqual({ ok: false, status: 404 });
    expect(await publicFormView(deps, B.slug, form.key)).toBeNull();
  });

  it("API keys: hashed, scoped to one gym and branch, revocable; idempotent retries", async () => {
    const { key, id } = await createApiKey(deps, A.ctx, {
      name: "Website",
      branchId: A.branchId,
    });
    const stored = await withTenant(app, A.tenantId, (tx) =>
      tx.tenantApiKey.findUniqueOrThrow({ where: { id } }),
    );
    expect(stored.secretHash).not.toContain(key.split("_")[2]!);
    const body = {
      first_name: "Api",
      phone: phone(),
      utm_campaign: "diwali-2026",
      consent: { given: true, text: "I agree to be contacted by Apex." },
    };
    expect(
      (
        await apiCreateLead(deps, {
          authorization: null,
          body,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await apiCreateLead(deps, {
          authorization: `Bearer ${key}x`,
          body,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(401);
    const first = await apiCreateLead(deps, {
      authorization: `Bearer ${key}`,
      body,
      idempotencyKey: "order-12345",
    });
    expect(first.status).toBe(201);
    const replay = await apiCreateLead(deps, {
      authorization: `Bearer ${key}`,
      body,
      idempotencyKey: "order-12345",
    });
    expect(replay).toMatchObject({
      status: 200,
      body: { id: first.body.id, replayed: true },
    });
    expect(
      (
        await apiCreateLead(deps, {
          authorization: `Bearer ${key}`,
          body: { ...body, first_name: "Other" },
          idempotencyKey: "order-12345",
        })
      ).status,
    ).toBe(409);
    const lead = await withTenant(app, A.tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: String(first.body.id) } }),
    );
    expect(lead.branchId).toBe(A.branchId);
    // Unknown fields (e.g. a tenant id) are refused, not ignored.
    expect(
      (
        await apiCreateLead(deps, {
          authorization: `Bearer ${key}`,
          body: { ...body, tenant_id: B.tenantId },
          idempotencyKey: null,
        })
      ).status,
    ).toBe(422);
    // Missing scope → 403; revoked → 401.
    await owner.$executeRaw`UPDATE app.tenant_api_key SET scopes = '{}' WHERE id = ${id}::uuid`;
    expect(
      (
        await apiCreateLead(deps, {
          authorization: `Bearer ${key}`,
          body,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(403);
    await owner.$executeRaw`UPDATE app.tenant_api_key SET scopes = '{leads.create}' WHERE id = ${id}::uuid`;
    await revokeApiKey(deps, A.ctx, id);
    expect(
      (
        await apiCreateLead(deps, {
          authorization: `Bearer ${key}`,
          body,
          idempotencyKey: null,
        })
      ).status,
    ).toBe(401);
  });
});

describe("trial → conversion → paid membership (one traceable chain)", () => {
  it("class trial takes a seat; trial pass works only here, today; payment wins the lead atomically", async () => {
    const plan = await createPlan(deps, A.ctx, {
      name: "Monthly",
      price: "1500",
      joiningFee: "",
      durationUnit: "MONTH",
      durationCount: "1",
      taxRateBps: "0",
      sacCode: "999723",
      accessScope: "HOME_BRANCH",
      refundRule: "NONE",
    });
    // A fixed mid-morning clock: the pass is valid on the trial's day only, so "an hour from
    // now" would be tomorrow when the suite runs late in the evening.
    const tenAm =
      startOfDayUtc(todayIn("Asia/Kolkata"), "Asia/Kolkata").getTime() +
      10 * 3600_000;
    const clock = { ...deps, now: () => new Date(tenAm) };
    const session = await withTenant(app, A.tenantId, (tx) =>
      tx.classSession.create({
        data: {
          tenantId: A.tenantId,
          branchId: A.branchId,
          name: "Morning HIIT",
          startsAt: new Date(tenAm + 60 * 60_000),
          endsAt: new Date(tenAm + 120 * 60_000),
          capacity: 1,
          bookingOpensHours: 168,
          bookingClosesMinutes: 0,
          cancelCutoffMinutes: 60,
          waitlistEnabled: false,
        },
      }),
    );
    const campaign = await withTenant(app, A.tenantId, (tx) =>
      tx.campaign.findFirstOrThrow({ where: { code: "diwali-2026" } }),
    );
    const lead = await createLead(deps, A.ctx, {
      firstName: "Trace",
      phone: phone(),
      email: "trace@x.in",
      branchId: A.branchId,
      campaignId: campaign.id,
    });
    const other = await createLead(deps, A.ctx, {
      firstName: "Second",
      phone: phone(),
      branchId: A.branchId,
    });
    const trial = await bookTrial(clock, A.ctx, lead.id, {
      mode: "CLASS",
      classSessionId: session.id,
      sendConfirmation: "on",
    });
    await expectCode(
      bookTrial(clock, A.ctx, other.id, {
        mode: "CLASS",
        classSessionId: session.id,
      }),
      "CONFLICT",
    ); // full
    expect((await getLead(deps, A.ctx, lead.id)).stage.category).toBe(
      "TRIAL_SCHEDULED",
    );
    const mail = await withTenant(app, A.tenantId, (tx) =>
      tx.notification.findFirst({
        where: { templateKey: "trial.booked", email: "trace@x.in" },
      }),
    );
    expect(mail?.body).toContain(`/t/${trial.passCode}`);
    // Trial pass: not at another gym or branch.
    const desk = await addStaff(A, "RECEPTIONIST");
    expect(
      await scanTrialPass(clock, B.ctx, {
        code: `GT1.${trial.passCode}`,
        branchId: B.branchId,
      }),
    ).toEqual({ ok: false, reason: "Unknown trial pass." });
    const scan = await scanTrialPass(clock, desk, {
      code: `GT1.${trial.passCode}`,
      branchId: A.branchId,
    });
    expect(scan).toMatchObject({ ok: true, name: "Trace" });
    expect(
      await scanTrialPass(clock, desk, {
        code: `GT1.${trial.passCode}`,
        branchId: A.branchId,
      }),
    ).toMatchObject({ ok: false });
    expect((await getLead(deps, A.ctx, lead.id)).stage.category).toBe(
      "TRIAL_ATTENDED",
    );

    const { memberId } = await convertLead(deps, A.ctx, lead.id, {});
    expect((await getLead(deps, A.ctx, lead.id)).status).toBe("OPEN"); // not won until paid
    // A sale can't claim a lead converted to someone else: nothing is created.
    const stranger = await convertLead(deps, A.ctx, other.id, {});
    const before = await withTenant(app, A.tenantId, (tx) =>
      tx.membership.count(),
    );
    await expectCode(
      sellMembership(deps, A.ctx, {
        memberId: stranger.memberId,
        planId: plan.id,
        leadId: lead.id,
      }),
      "VALIDATION_FAILED",
    );
    expect(
      await withTenant(app, A.tenantId, (tx) => tx.membership.count()),
    ).toBe(before);
    // Unpaid sale: still open.
    const sale = await sellMembership(deps, A.ctx, {
      memberId,
      planId: plan.id,
      leadId: lead.id,
    });
    expect((await getLead(deps, A.ctx, lead.id)).status).toBe("OPEN");
    // Payment → membership active → lead WON with links, same transaction.
    const { recordPayment } = await import("@gym/core/billing");
    await recordPayment(deps, A.ctx, {
      memberId,
      method: "CASH",
      amountMinor: 150_000,
      allocations: [{ invoiceId: sale.invoice.id, amountMinor: 150_000 }],
    });
    const won = await getLead(deps, A.ctx, lead.id);
    expect(won).toMatchObject({
      status: "WON",
      convertedMemberId: memberId,
      convertedMembershipId: sale.membership.id,
    });
    expect(won.stage.category).toBe("WON");
    expect(won.tasks.every((t) => t.status !== "OPEN")).toBe(true);
    const converted = await events(A, "lead.converted");
    expect(converted).toHaveLength(1);
    expect(
      (converted[0]!.payload as { data: { campaignId: string } }).data
        .campaignId,
    ).toBe(campaign.id);
    // Attribution: the campaign shows 1 paid member and its revenue.
    const report = await attributionReport(deps, A.ctx, {});
    const row = report.rows.find((r) => r.key === campaign.id)!;
    expect(row).toMatchObject({
      won: 1,
      trialsAttended: 1,
      revenueMinor: 150_000,
    });
  });

  it("lost needs a reason, cancels open tasks and frees trial seats", async () => {
    const lead = await createLead(deps, A.ctx, {
      firstName: "Gone",
      phone: phone(),
      branchId: A.branchId,
    });
    await bookTrial(deps, A.ctx, lead.id, {
      mode: "SLOT",
      start: localAt(Date.now() + 86_400_000),
      minutes: "60",
    });
    await expectCode(
      markLeadLost(deps, A.ctx, lead.id, {}),
      "VALIDATION_FAILED",
    );
    const reason = (await getCrmSetup(deps, A.ctx)).lostReasons[0]!;
    await markLeadLost(deps, A.ctx, lead.id, {
      lostReasonId: reason.id,
      note: "Moved",
    });
    const detail = await getLead(deps, A.ctx, lead.id);
    expect(detail).toMatchObject({ status: "LOST", lostReasonId: reason.id });
    expect(detail.tasks.every((t) => t.status === "CANCELLED")).toBe(true);
    expect(detail.trials.every((t) => t.status === "CANCELLED")).toBe(true);
    expect(await events(A, "lead.lost")).toHaveLength(1);
  });
});

describe("events and the CRM tick", () => {
  it("each handler runs exactly once per event; a failing handler is retried alone", async () => {
    const lead = await createLead(deps, A.ctx, {
      firstName: "Evt",
      phone: phone(),
      branchId: A.branchId,
    });
    const [event] = (await events(A, "lead.created")).filter(
      (e) =>
        (e.payload as { data: { leadId: string } }).data.leadId === lead.id,
    );
    const runs = { ok: 0, flaky: 0 };
    let fail = true;
    const handlers: EventHandler[] = [
      {
        name: "test.ok",
        types: ["lead.created"],
        handle: async () => void runs.ok++,
      },
      {
        name: "test.flaky",
        types: ["lead.created"],
        handle: async () => {
          runs.flaky++;
          if (fail) throw new Error("boom");
        },
      },
    ];
    await expect(
      dispatchEvent(app, A.tenantId, event!.id, handlers),
    ).rejects.toThrow("boom");
    fail = false;
    const second = await dispatchEvent(app, A.tenantId, event!.id, handlers);
    expect(second).toEqual({ ran: ["test.flaky"], skipped: ["test.ok"] });
    // Parallel duplicate deliveries: still once.
    await Promise.all(
      [1, 2, 3].map(() => dispatchEvent(app, A.tenantId, event!.id, handlers)),
    );
    expect(runs).toEqual({ ok: 1, flaky: 2 });
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.eventConsumption.count({ where: { eventId: event!.id } }),
      ),
    ).toBe(2);
    // The receipts are append-only.
    await expect(
      withTenant(
        app,
        A.tenantId,
        (tx) => tx.$executeRaw`DELETE FROM app.event_consumption`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("SLA breach fires once; reminders once; missed trials become no-shows", async () => {
    const T = await makeGym("Ticky");
    const sales = await addStaff(T, "SALES_STAFF", T.branchId);
    const lead = await createLead(deps, T.ctx, {
      firstName: "Slow",
      phone: phone(),
      branchId: T.branchId,
      ownerUserId: sales.userId,
    });
    const later = new Date(Date.now() + 20 * 60_000);
    const first = await withTenant(app, T.tenantId, (tx) =>
      crmTick(tx, T.tenantId, later),
    );
    expect(first.slaBreached).toBe(1);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const again = await withTenant(app, T.tenantId, (tx) =>
      crmTick(tx, T.tenantId, later),
    );
    expect(again).toMatchObject({ slaBreached: 0, reminded: 0 });
    expect(await events(T, "lead.uncontacted_sla_breached")).toHaveLength(1);
    // A call counts as contact: no breach for the next lead.
    const fast = await createLead(deps, T.ctx, {
      firstName: "Fast",
      phone: phone(),
      branchId: T.branchId,
    });
    await logLeadActivity(deps, T.ctx, fast.id, {
      type: "CALL",
      outcome: "ANSWERED",
    });
    expect((await getLead(deps, T.ctx, fast.id)).stage.category).toBe(
      "CONTACTED",
    );
    expect(
      (
        await withTenant(app, T.tenantId, (tx) =>
          crmTick(tx, T.tenantId, later),
        )
      ).slaBreached,
    ).toBe(0);
    // Missed trial.
    const trial = await bookTrial(deps, T.ctx, lead.id, {
      mode: "SLOT",
      start: localAt(Date.now() + 5 * 60_000),
      minutes: "30",
    });
    const tick = await withTenant(app, T.tenantId, (tx) =>
      crmTick(tx, T.tenantId, new Date(Date.now() + 4 * 3_600_000)),
    );
    expect(tick.noShows).toBe(1);
    const t = await withTenant(app, T.tenantId, (tx) =>
      tx.trialBooking.findUniqueOrThrow({ where: { id: trial.id } }),
    );
    expect(t.status).toBe("NO_SHOW");
    expect(
      (await getLead(deps, T.ctx, lead.id)).tasks.some(
        (x) => x.kind === "CALLBACK" && x.status === "OPEN",
      ),
    ).toBe(true);
    // Staff can still record that they came after all.
    await markTrial(deps, T.ctx, trial.id, { outcome: "ATTENDED" });
  });
});

describe("isolation", () => {
  it("another gym or another branch's staff can't see a lead", async () => {
    const lead = await createLead(deps, A.ctx, {
      firstName: "Private",
      phone: phone(),
      branchId: A.branchId,
    });
    await expectCode(getLead(deps, B.ctx, lead.id), "NOT_FOUND");
    const second = await withTenant(app, A.tenantId, (tx) =>
      tx.branch.create({
        data: {
          tenantId: A.tenantId,
          code: "B2",
          name: "Apex Two",
          stateCode: "08",
        },
      }),
    );
    const far = await addStaff(A, "SALES_STAFF", second.id);
    await expectCode(getLead(deps, far, lead.id), "NOT_FOUND");
    expect(
      (await listLeads(deps, far, {})).rows.find((r) => r.id === lead.id),
    ).toBeUndefined();
    const board = await pipelineBoard(deps, far, {});
    expect(
      board.flatMap((c) => c.leads).find((l) => l.id === lead.id),
    ).toBeUndefined();
    // Database layer: B's transaction sees none of A's CRM rows.
    expect(
      await withTenant(app, B.tenantId, (tx) =>
        tx.lead.count({ where: { id: lead.id } }),
      ),
    ).toBe(0);
    await withTenant(app, B.tenantId, (tx) =>
      ensureCrmDefaults(tx, B.tenantId),
    );
  });
});

describe("job hardening: outbox dead letters (operator)", () => {
  it("the operator sees failed outbox rows (no payload) and can retry one; the gym role can't", async () => {
    const { outboxHealth, retryOutboxRow } =
      await import("@gym/core/saas-billing");
    const platformDb = createPrismaClient(db.platformUrl);
    try {
      const row = await owner.outbox.create({
        data: {
          tenantId: A.tenantId,
          topic: "event",
          payload: { secret: "do-not-show" },
          status: "FAILED",
          attempts: 10,
          lastError: "handler exploded",
        },
      });
      const admin = await platformDb.platformUser.create({
        data: {
          email: `ops${Date.now()}@platform.test`,
          name: "Ops",
          role: "SUPER_ADMIN",
        },
      });
      const pctx = {
        platformUserId: admin.id,
        role: "SUPER_ADMIN" as const,
        permissions: new Set([
          "platform.system.view",
          "platform.billing.manage",
        ] as const),
      };
      const health = await outboxHealth(platformDb, pctx as never);
      const dead = health.deadLetters.find((d) => d.id === row.id);
      expect(dead).toMatchObject({
        topic: "event",
        attempts: 10,
        lastError: "handler exploded",
        tenantName: "Apex",
      });
      expect(JSON.stringify(health)).not.toContain("do-not-show");
      expect(
        health.stats.some((s) => s.status === "FAILED" && s.topic === "event"),
      ).toBe(true);
      await retryOutboxRow(platformDb, pctx as never, { id: row.id });
      expect(
        (await owner.outbox.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe("PENDING");
      await expectCode(
        retryOutboxRow(platformDb, pctx as never, { id: row.id }),
        "CONFLICT",
      );
      await expect(
        app.$queryRaw`SELECT * FROM platform_api.outbox_dead_letters(10)`,
      ).rejects.toThrow(/permission denied/);
      await owner.outbox.update({
        where: { id: row.id },
        data: { status: "DONE" },
      });
    } finally {
      await platformDb.$disconnect();
    }
  });
});
