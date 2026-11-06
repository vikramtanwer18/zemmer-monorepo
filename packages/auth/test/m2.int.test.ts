import type { AuthContext } from "@gym/core/authz";
import { gstinCheckChar } from "@gym/core/gst";
import {
  invoiceBalances,
  issueInvoiceTx,
  recordPayment,
  recordPaymentSchema,
  recordPaymentTx,
  voidPayment,
} from "@gym/core/billing";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import {
  createMember,
  decideJoinRequest,
  exportMembersCsv,
  importMembers,
  getJoinPage,
  getMyInvoice,
  getMyProfile,
  grantMemberAppAccess,
  inviteMemberToApp,
  listMyInvoices,
  listMyMemberGyms,
  requestToJoin,
  resolveMemberContext,
  setMyMarketingConsent,
  updateMyProfile,
} from "@gym/core/members";
import {
  cancelMembership,
  freezeMembership,
  previewSale,
  renewMembership,
  runDailyMembershipJob,
  sellMembership,
  unfreezeMembership,
} from "@gym/core/memberships";
import { getDashboardMetrics } from "@gym/core/metrics";
import { createCoupon, createPlan } from "@gym/core/plans";
import {
  acceptInvitation,
  createTenantForOwner,
  entitlementsFor,
  loadTenantAccess,
  type CoreDeps,
} from "@gym/core/tenancy";
import { todayIn } from "@gym/core/time/dates";
import {
  createPrismaClient,
  withTenant,
  type PrismaClient,
  type TenantTransaction,
} from "@gym/db";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoMembers } from "../scripts/demo-members";
import { grantsFor } from "../src/permissions";

let db: TestDatabase;
let app: PrismaClient;
let owner: PrismaClient;
let deps: CoreDeps;

// Frozen clock for deterministic dates: 10:00 IST on 3 Nov 2026.
const NOW = new Date("2026-11-03T04:30:00Z");
const TODAY = "2026-11-03";

const GSTIN_A = `08ABCDE1234F1Z${gstinCheckChar("08ABCDE1234F1Z")}`;

type Gym = {
  tenantId: string;
  ownerId: string;
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

async function makeGym(
  name: string,
  stateCode: string,
  timezone = "Asia/Kolkata",
): Promise<Gym> {
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
    { gymName: name, stateCode, branchName: `${name} Main`, timezone },
  );
  // Generous plan so quotas don't interfere.
  await owner.$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'pro') WHERE tenant_id = ${tenantId}::uuid`;
  const branchId = await withTenant(
    app,
    tenantId,
    async (tx) => (await tx.branch.findFirstOrThrow()).id,
  );
  return {
    tenantId,
    ownerId: user.id,
    branchId,
    ctx: await ctxFor(user.id, tenantId),
  };
}

async function addStaff(gym: Gym, roleKey: string, email: string) {
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

const planInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Monthly Unlimited",
  price: "1180",
  joiningFee: "500",
  durationUnit: "MONTH",
  durationCount: "1",
  taxRateBps: "1800",
  sacCode: "999723",
  accessScope: "HOME_BRANCH",
  freezeMaxDays: "15",
  freezeMaxTimes: "2",
  refundRule: "PRORATA",
  ...overrides,
});

let A: Gym; // GST-registered, Rajasthan, prices include tax
let B: Gym; // unregistered, Maharashtra
let planA: { id: string };
let planB: { id: string };

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  deps = { db: app, entitlements: noEntitlementCache, now: () => NOW };
  A = await makeGym("Alpha", "08");
  B = await makeGym("Beta", "27");
  await owner.$executeRaw`UPDATE app.tenant_settings SET gst_registered = true, gstin = ${GSTIN_A}, state_code = '08', prices_include_tax = true, invoice_prefix = 'AL' WHERE tenant_id = ${A.tenantId}::uuid`;
  planA = await createPlan(deps, A.ctx, planInput());
  planB = await createPlan(
    deps,
    B.ctx,
    planInput({ name: "Beta Monthly", price: "1000", joiningFee: "" }),
  );
});

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

const newMember = (
  gym: Gym,
  first: string,
  extra: Record<string, unknown> = {},
) =>
  createMember(deps, gym.ctx, {
    firstName: first,
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    homeBranchId: gym.branchId,
    ...extra,
  });

describe("members", () => {
  it("detects duplicates by phone within the tenant, and allows them when confirmed", async () => {
    await createMember(deps, A.ctx, {
      firstName: "Asha",
      phone: "98765 43210",
      email: "asha@x.test",
      homeBranchId: A.branchId,
    });
    const err = await expectCode(
      createMember(deps, A.ctx, {
        firstName: "Asha 2",
        phone: "+919876543210",
        homeBranchId: A.branchId,
      }),
      "CONFLICT",
    );
    expect((err.details as { duplicates: unknown[] }).duplicates).toHaveLength(
      1,
    );
    // Another gym may have the same person.
    await createMember(deps, B.ctx, {
      firstName: "Asha",
      phone: "9876543210",
      homeBranchId: B.branchId,
    });
    await createMember(deps, A.ctx, {
      firstName: "Asha 2",
      phone: "9876543210",
      homeBranchId: A.branchId,
      confirmDuplicate: "on",
    });
  });

  it("records service consent by default and marketing only when ticked", async () => {
    const m = await newMember(A, "Consent", {
      email: "c@x.test",
      marketingEmail: "on",
    });
    const rows = await withTenant(app, A.tenantId, (tx) =>
      tx.contactConsent.findMany({ where: { memberId: m.id } }),
    );
    const keys = rows
      .map((r) => `${r.channel}:${r.purpose}:${r.status}`)
      .sort();
    expect(keys).toEqual([
      "EMAIL:MARKETING:GRANTED",
      "EMAIL:SERVICE:GRANTED",
      "WHATSAPP:SERVICE:GRANTED",
    ]);
  });
});

describe("sell → partial cash → remaining UPI → active", () => {
  it("activates only on full payment, atomically, with GST split and audit", async () => {
    const member = await newMember(A, "Ravi", { email: "ravi@x.test" });
    const preview = await previewSale(deps, A.ctx, {
      memberId: member.id,
      planId: planA.id,
    });
    expect(preview.draft.documentType).toBe("TAX_INVOICE");
    expect(preview.draft.totals).toEqual({
      taxableMinor: 142_373,
      cgstMinor: 12_814,
      sgstMinor: 12_813,
      igstMinor: 0,
      totalMinor: 168_000,
    });

    const sale = await sellMembership(deps, A.ctx, {
      memberId: member.id,
      planId: planA.id,
    });
    expect(sale.membership.status).toBe("PENDING_PAYMENT");
    expect(sale.invoice.number).toBe("AL/26-27/00001");
    expect(Number(sale.invoice.totalMinor)).toBe(168_000);

    await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 100_000,
    });
    let state = await withTenant(app, A.tenantId, async (tx) => ({
      membership: await tx.membership.findUniqueOrThrow({
        where: { id: sale.membership.id },
      }),
      invoice: await tx.gymInvoice.findUniqueOrThrow({
        where: { id: sale.invoice.id },
      }),
    }));
    expect(state.membership.status).toBe("PENDING_PAYMENT");
    expect(state.invoice.status).toBe("PARTIALLY_PAID");

    await expectCode(
      recordPayment(deps, A.ctx, {
        memberId: member.id,
        method: "UPI",
        amountMinor: 68_000,
      }),
      "VALIDATION_FAILED",
    ); // UPI needs a reference
    await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "UPI",
      amountMinor: 68_000,
      reference: "UPI-4455",
    });
    state = await withTenant(app, A.tenantId, async (tx) => ({
      membership: await tx.membership.findUniqueOrThrow({
        where: { id: sale.membership.id },
      }),
      invoice: await tx.gymInvoice.findUniqueOrThrow({
        where: { id: sale.invoice.id },
      }),
    }));
    expect(state.membership.status).toBe("ACTIVE");
    expect(state.invoice.status).toBe("PAID");

    const trail = await withTenant(app, A.tenantId, async (tx) => ({
      events: (
        await tx.membershipEvent.findMany({
          where: { membershipId: sale.membership.id },
          orderBy: { createdAt: "asc" },
        })
      ).map((e) => e.type),
      audit: (
        await tx.auditLog.findMany({
          where: {
            action: {
              in: [
                "membership.sold",
                "invoice.issued",
                "payment.recorded",
                "membership.activated",
              ],
            },
          },
        })
      ).map((a) => a.action),
      receipts: (
        await tx.gymPayment.findMany({
          where: { memberId: member.id },
          orderBy: { receiptNumber: "asc" },
        })
      ).map((p) => p.receiptNumber),
      emails: await tx.notification.count({
        where: { memberId: member.id, channel: "EMAIL", status: "PENDING" },
      }),
      outbox: await tx.outbox.count({ where: { topic: "notification.email" } }),
    }));
    expect(trail.events).toEqual(["CREATED", "ACTIVATED"]);
    expect(new Set(trail.audit)).toEqual(
      new Set([
        "membership.sold",
        "invoice.issued",
        "payment.recorded",
        "membership.activated",
      ]),
    );
    expect(trail.receipts).toEqual(["RC/26-27/00001", "RC/26-27/00002"]);
    // invoice issued + 2 payments received + activated
    expect(trail.emails).toBe(4);
    expect(trail.outbox).toBeGreaterThanOrEqual(4);
  });

  it("refuses an overlapping second membership", async () => {
    const member = await newMember(A, "Overlap");
    await sellMembership(deps, A.ctx, {
      memberId: member.id,
      planId: planA.id,
    });
    await expectCode(
      sellMembership(deps, A.ctx, { memberId: member.id, planId: planA.id }),
      "CONFLICT",
    );
  });
});

describe("GST vs unregistered documents", () => {
  it("an unregistered gym issues a Bill with no tax lines", async () => {
    const member = await newMember(B, "Unreg");
    const sale = await sellMembership(deps, B.ctx, {
      memberId: member.id,
      planId: planB.id,
    });
    const invoice = await withTenant(app, B.tenantId, (tx) =>
      tx.gymInvoice.findUniqueOrThrow({
        where: { id: sale.invoice.id },
        include: { lines: true },
      }),
    );
    expect(invoice.documentType).toBe("BILL");
    expect(invoice.number).toBe("INV/26-27/00001");
    expect([
      Number(invoice.cgstMinor),
      Number(invoice.sgstMinor),
      Number(invoice.igstMinor),
    ]).toEqual([0, 0, 0]);
    expect(Number(invoice.totalMinor)).toBe(100_000);
    expect(invoice.lines.every((l) => l.taxRateBps === 0)).toBe(true);
  });

  it("issued invoices are immutable in the database", async () => {
    const invoice = await withTenant(app, A.tenantId, (tx) =>
      tx.gymInvoice.findFirstOrThrow(),
    );
    await expect(
      withTenant(app, A.tenantId, (tx) =>
        tx.gymInvoice.update({
          where: { id: invoice.id },
          data: { totalMinor: 1 },
        }),
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe("numbering under concurrency", () => {
  it("parallel transactions never duplicate or skip a number", async () => {
    const member = await newMember(B, "Busy");
    const issue = () =>
      withTenant(app, B.tenantId, (tx) =>
        issueInvoiceTx(tx, B.ctx, B.tenantId, {
          branchId: B.branchId,
          memberId: member.id,
          lines: [
            {
              kind: "OTHER",
              description: "Towel",
              unitPriceMinor: 5_000,
              rateBps: 1800,
            },
          ],
          issueDate: TODAY,
        }),
      );
    const before = await withTenant(app, B.tenantId, (tx) =>
      tx.gymInvoice.count(),
    );
    const results = await Promise.all(Array.from({ length: 12 }, issue));
    const numbers = results
      .map((r) => Number(r.number.split("/")[2]))
      .sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers).toEqual(
      Array.from({ length: 12 }, (_, i) => before + 1 + i),
    );
  });

  it("a rolled-back issuance releases its number (gap-free)", async () => {
    const member = await newMember(B, "Rollback");
    const series = () =>
      withTenant(app, B.tenantId, (tx) =>
        tx.invoiceSeries.findFirstOrThrow({ where: { kind: "INVOICE" } }),
      );
    const next = (await series()).nextNumber;
    await expect(
      withTenant(app, B.tenantId, async (tx) => {
        await issueInvoiceTx(tx, B.ctx, B.tenantId, {
          branchId: B.branchId,
          memberId: member.id,
          lines: [
            {
              kind: "OTHER",
              description: "x",
              unitPriceMinor: 100,
              rateBps: 0,
            },
          ],
          issueDate: TODAY,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await series()).nextNumber).toBe(next);
  });
});

describe("atomicity", () => {
  it("payment + allocation + activation roll back together", async () => {
    const member = await newMember(A, "Atomic");
    const sale = await sellMembership(deps, A.ctx, {
      memberId: member.id,
      planId: planA.id,
    });
    await expect(
      withTenant(app, A.tenantId, async (tx) => {
        await recordPaymentTx(
          tx,
          A.ctx,
          recordPaymentSchema.parse({
            memberId: member.id,
            method: "CASH",
            amountMinor: 168_000,
          }),
          NOW,
        );
        throw new Error("crash after activation");
      }),
    ).rejects.toThrow("crash");
    const after = await withTenant(app, A.tenantId, async (tx) => ({
      status: (
        await tx.membership.findUniqueOrThrow({
          where: { id: sale.membership.id },
        })
      ).status,
      payments: await tx.gymPayment.count({ where: { memberId: member.id } }),
      allocations: await tx.paymentAllocation.count({
        where: { invoiceId: sale.invoice.id },
      }),
    }));
    expect(after).toEqual({
      status: "PENDING_PAYMENT",
      payments: 0,
      allocations: 0,
    });
  });
});

describe("overpayment and credit", () => {
  it("overpayment becomes credit, which pays the next invoice automatically", async () => {
    const member = await newMember(B, "Overpay");
    const first = await sellMembership(deps, B.ctx, {
      memberId: member.id,
      planId: planB.id,
    });
    const pay = await recordPayment(deps, B.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 150_000,
    });
    expect(pay.creditMinor).toBe(50_000);
    const renewal = await renewMembership(deps, B.ctx, first.membership.id, {});
    const balance = await withTenant(app, B.tenantId, async (tx) => ({
      invoice: (await invoiceBalances(tx, [renewal.invoice.id])).get(
        renewal.invoice.id,
      )!,
      credit: Number(
        (
          await tx.memberCreditEntry.aggregate({
            where: { memberId: member.id },
            _sum: { amountMinor: true },
          })
        )._sum.amountMinor,
      ),
    }));
    expect(balance.invoice).toMatchObject({
      totalMinor: 100_000,
      allocatedMinor: 50_000,
      outstandingMinor: 50_000,
    });
    expect(balance.credit).toBe(0);
    // Renewal starts the day after the current end.
    expect(renewal.membership.startDate.toISOString().slice(0, 10)).toBe(
      "2026-12-03",
    );
  });

  it("voiding a payment needs billing.void: receptionists can't, accountants can", async () => {
    const member = await newMember(A, "Voidable");
    await sellMembership(deps, A.ctx, {
      memberId: member.id,
      planId: planA.id,
    });
    const { payment } = await recordPayment(deps, A.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 10_000,
    });
    const receptionist = await addStaff(A, "RECEPTIONIST", "rec@alpha.test");
    const accountant = await addStaff(A, "ACCOUNTANT", "acc@alpha.test");
    await expectCode(
      voidPayment(deps, receptionist, payment.id, "Entered twice"),
      "FORBIDDEN",
    );
    await voidPayment(deps, accountant, payment.id, "Entered twice");
    const p = await withTenant(app, A.tenantId, (tx) =>
      tx.gymPayment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { allocations: true },
      }),
    );
    expect(p.status).toBe("VOID");
    expect(p.allocations.every((a) => a.reversedAt !== null)).toBe(true);
  });
});

describe("freeze, cancel and refund", () => {
  it("freezing extends the end date; unfreezing early gives back unused days", async () => {
    const member = await newMember(B, "Freezer");
    const sale = await sellMembership(deps, B.ctx, {
      memberId: member.id,
      planId: planB.id,
    });
    await recordPayment(deps, B.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 100_000,
    });
    const end = (id: string) =>
      withTenant(app, B.tenantId, (tx) =>
        tx.membership.findUniqueOrThrow({ where: { id } }),
      );
    expect(
      (await end(sale.membership.id)).endDate.toISOString().slice(0, 10),
    ).toBe("2026-12-02");
    await freezeMembership(deps, B.ctx, sale.membership.id, {
      days: 10,
      reason: "Travel",
    });
    let m = await end(sale.membership.id);
    expect(m.status).toBe("PAUSED");
    expect(m.endDate.toISOString().slice(0, 10)).toBe("2026-12-12");
    await expectCode(
      freezeMembership(deps, B.ctx, sale.membership.id, {
        days: 3,
        reason: "Again",
      }),
      "CONFLICT",
    );
    await unfreezeMembership(deps, B.ctx, sale.membership.id); // same day: 0 days used
    m = await end(sale.membership.id);
    expect(m.status).toBe("ACTIVE");
    expect(m.endDate.toISOString().slice(0, 10)).toBe("2026-12-02");
    expect(m.freezeCount).toBe(0);
  });

  it("cancelling refunds within the plan's rule via credit note + manual refund", async () => {
    const member = await newMember(B, "Leaver");
    const sale = await sellMembership(deps, B.ctx, {
      memberId: member.id,
      planId: planB.id,
      startDate: "2026-11-10",
    });
    await recordPayment(deps, B.ctx, {
      memberId: member.id,
      method: "CASH",
      amountMinor: 100_000,
    });
    // Not started yet: PRORATA allows the full amount.
    await expectCode(
      cancelMembership(deps, B.ctx, sale.membership.id, {
        reason: "Moving city",
        refundMinor: 100_001,
        refundMethod: "CASH",
      }),
      "VALIDATION_FAILED",
    );
    await cancelMembership(deps, B.ctx, sale.membership.id, {
      reason: "Moving city",
      refundMinor: 100_000,
      refundMethod: "CASH",
    });
    const state = await withTenant(app, B.tenantId, async (tx) => ({
      membership: (
        await tx.membership.findUniqueOrThrow({
          where: { id: sale.membership.id },
        })
      ).status,
      invoice: (
        await tx.gymInvoice.findUniqueOrThrow({
          where: { id: sale.invoice.id },
        })
      ).status,
      credit: Number(
        (
          await tx.memberCreditEntry.aggregate({
            where: { memberId: member.id },
            _sum: { amountMinor: true },
          })
        )._sum.amountMinor,
      ),
      notes: await tx.creditNote.count({
        where: { invoiceId: sale.invoice.id },
      }),
    }));
    expect(state).toEqual({
      membership: "CANCELLED",
      invoice: "REFUNDED",
      credit: 0,
      notes: 1,
    });
  });
});

describe("member app isolation", () => {
  it("a member sees only their own invoices", async () => {
    const one = await newMember(B, "Member One", { email: "one@x.test" });
    const two = await newMember(B, "Member Two", { email: "two@x.test" });
    const s1 = await sellMembership(deps, B.ctx, {
      memberId: one.id,
      planId: planB.id,
    });
    const s2 = await sellMembership(deps, B.ctx, {
      memberId: two.id,
      planId: planB.id,
    });
    const user = await app.user.create({
      data: { email: "one@x.test", name: "Member One", emailVerified: true },
    });
    await withTenant(app, B.tenantId, (tx) =>
      grantMemberAppAccess(tx, B.tenantId, one.id, user.id, B.branchId),
    );
    const mctx = await resolveMemberContext(app, user.id, B.tenantId);
    expect(mctx?.memberId).toBe(one.id);
    const mine = await listMyInvoices(app, mctx!);
    expect(mine.invoices.map((i) => i.id)).toEqual([s1.invoice.id]);
    await expectCode(getMyInvoice(app, mctx!, s2.invoice.id), "NOT_FOUND");
    // The same account has no member context in a gym where it isn't a member.
    expect(await resolveMemberContext(app, user.id, A.tenantId)).toBeNull();
  });
});

describe("CSV import and export", () => {
  it("dry run changes nothing; the real run imports valid rows and reports the rest", async () => {
    const G = await makeGym("Importers", "08");
    const code = await withTenant(
      app,
      G.tenantId,
      async (tx) =>
        (await tx.branch.findUniqueOrThrow({ where: { id: G.branchId } })).code,
    );
    await newMember(G, "Existing", { phone: "9811100000" });
    const csv = [
      "first_name,last_name,phone,email,branch_code,marketing_email",
      `Asha,Rao,9811100001,asha@x.test,${code},yes`,
      `Dupe,Phone,9811100000,,${code},`, // same phone as an existing member
      `Bad,Branch,9811100002,,NOPE,`,
      `,NoName,9811100003,,${code},`,
      `"=HYPERLINK(""x"")",Formula,9811100004,,${code},`,
    ].join("\n");
    const ent = await entitlementsFor(deps, G.tenantId);
    const runRow = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
      withTenant(app, G.tenantId, fn, { userId: G.ownerId });
    const count = () =>
      withTenant(app, G.tenantId, (tx) => tx.memberProfile.count());

    const dry = await importMembers(G.ctx, ent, csv, { dryRun: true, runRow });
    expect(dry).toMatchObject({
      dryRun: true,
      total: 5,
      imported: 2,
      duplicates: 1,
      errors: 2,
    });
    expect(await count()).toBe(1);

    const real = await importMembers(G.ctx, ent, csv, {
      dryRun: false,
      runRow,
    });
    expect(real).toMatchObject({
      dryRun: false,
      imported: 2,
      duplicates: 1,
      errors: 2,
    });
    expect(real.rows.find((r) => r.row === 4)?.message).toMatch(
      /Unknown branch code/,
    );
    expect(await count()).toBe(3);
    // Marketing consent only where the file says yes, recorded with the import as its source.
    const asha = await withTenant(app, G.tenantId, (tx) =>
      tx.memberProfile.findFirstOrThrow({
        where: { firstName: "Asha" },
        include: { consents: true },
      }),
    );
    expect(asha.source).toBe("IMPORT");
    expect(
      asha.consents.some(
        (c) =>
          c.purpose === "MARKETING" &&
          c.channel === "EMAIL" &&
          c.status === "GRANTED",
      ),
    ).toBe(true);

    // Export: spreadsheet formulas are neutralised; receptionists may not export or import.
    const { csv: out, count: rows } = await withTenant(app, G.tenantId, (tx) =>
      exportMembersCsv(tx, G.ctx, {}),
    );
    expect(rows).toBe(3);
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
    const reception = await addStaff(G, "RECEPTIONIST", "rec@importers.test");
    await expectCode(
      importMembers(reception, ent, csv, { dryRun: true, runRow }),
      "FORBIDDEN",
    );
    await expectCode(
      withTenant(app, G.tenantId, (tx) => exportMembersCsv(tx, reception, {})),
      "FORBIDDEN",
    );
  });
});

describe("member app invite", () => {
  it("accepting links the account to the member profile with a MEMBER role only", async () => {
    const m = await newMember(B, "Invited", { email: "invited@x.test" });
    let token = "";
    await inviteMemberToApp(
      deps,
      async (mail) => void (token = mail.token),
      B.ctx,
      m.id,
    );
    expect(token).not.toBe("");
    const user = await app.user.create({
      data: { email: "invited@x.test", name: "Invited", emailVerified: true },
    });
    await acceptInvitation(deps, user, token);
    const mctx = await resolveMemberContext(app, user.id, B.tenantId);
    expect(mctx?.memberId).toBe(m.id);
    const access = await loadTenantAccess(app, user.id, B.tenantId);
    expect(access?.roles.map((r) => r.roleKey)).toEqual(["MEMBER"]);
    // The link is single-use.
    await expectCode(acceptInvitation(deps, user, token), "CONFLICT");
  });
});

describe("join link and member self-service", () => {
  const slugOf = async (gym: Gym) =>
    (await owner.tenant.findUniqueOrThrow({ where: { id: gym.tenantId } }))
      .slug;
  const setJoin = (gym: Gym, on: boolean, approval: boolean) =>
    owner.$executeRaw`UPDATE app.tenant_settings SET member_self_signup = ${on}, member_join_approval = ${approval} WHERE tenant_id = ${gym.tenantId}::uuid`;

  it("is closed unless the gym turns it on; approval gates the member app", async () => {
    const E = await makeGym("Epsilon", "08");
    const slug = await slugOf(E);
    expect(await getJoinPage(deps, slug)).toBeNull();
    await setJoin(E, true, true);
    const page = await getJoinPage(deps, slug);
    expect(page).toMatchObject({
      tenantId: E.tenantId,
      needsApproval: true,
      branches: [{ id: E.branchId }],
    });

    const unverified = await app.user.create({
      data: { email: "nov@x.test", name: "No Verify", emailVerified: false },
    });
    await expectCode(
      requestToJoin(deps, unverified, slug, {
        phone: "9811111111",
        homeBranchId: E.branchId,
      }),
      "FORBIDDEN",
    );

    const user = await app.user.create({
      data: { email: "joiner@x.test", name: "Jo Iner", emailVerified: true },
    });
    const joined = await requestToJoin(deps, user, slug, {
      phone: "9822222222",
      homeBranchId: E.branchId,
      marketingEmail: "on",
    });
    expect(joined.status).toBe("PENDING_APPROVAL");
    // Asking twice doesn't create a second profile.
    expect(
      (
        await requestToJoin(deps, user, slug, {
          phone: "9822222222",
          homeBranchId: E.branchId,
        })
      ).memberId,
    ).toBe(joined.memberId);
    expect(await listMyMemberGyms(app, user.id)).toEqual([]);

    await decideJoinRequest(deps, E.ctx, joined.memberId, true);
    const gyms = await listMyMemberGyms(app, user.id);
    expect(gyms.map((g) => g.tenantId)).toEqual([E.tenantId]);
    const mctx = (await resolveMemberContext(app, user.id, E.tenantId))!;

    // The member may change their phone and marketing choice; both are audited, opt-out applies at once.
    await updateMyProfile(app, mctx, {
      phone: "98333 33333",
      emergencyName: "Mum",
    });
    await setMyMarketingConsent(app, mctx, { channel: "EMAIL" });
    const { profile, consents } = await getMyProfile(app, mctx);
    expect(profile.phone).toBe("+919833333333");
    expect(consents.marketingEmail).toBe(false);
    const actions = await withTenant(app, E.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: joined.memberId },
        select: { action: true },
      }),
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "member.self_signup",
        "member.self_updated",
        "member.consent_changed",
      ]),
    );
  });

  it("without approval, the account gets the member app straight away", async () => {
    const F = await makeGym("Zeta", "08");
    await setJoin(F, true, false);
    const user = await app.user.create({
      data: { email: "fast@x.test", name: "Fast Joiner", emailVerified: true },
    });
    const joined = await requestToJoin(deps, user, await slugOf(F), {
      phone: "9844444444",
      homeBranchId: F.branchId,
    });
    expect(joined.status).toBe("ACTIVE");
    const mctx = await resolveMemberContext(app, user.id, F.tenantId);
    expect(mctx?.memberId).toBe(joined.memberId);
    // A MEMBER role only: no staff permission leaks in.
    const access = await loadTenantAccess(app, user.id, F.tenantId);
    expect(access?.roles.map((r) => r.roleKey)).toEqual(["MEMBER"]);
    expect(
      grantsFor(access!.roles).some((g) => g.permissions.has("members.view")),
    ).toBe(false);
  });
});

describe("daily job across timezones", () => {
  it("expires by each tenant's local date (IST vs New York)", async () => {
    const C = await makeGym("Gamma", "08", "America/New_York");
    const plan = await createPlan(
      deps,
      C.ctx,
      planInput({
        name: "Day Pass",
        price: "100",
        joiningFee: "",
        durationUnit: "DAY",
        durationCount: "1",
        refundRule: "NONE",
      }),
    );
    const ny = await newMember(C, "NY");
    const ist = await newMember(B, "IST");
    const dayPlan = await createPlan(
      deps,
      B.ctx,
      planInput({
        name: "Day Pass B",
        price: "100",
        joiningFee: "",
        durationUnit: "DAY",
        durationCount: "1",
      }),
    );
    // 2 Nov local in both zones; activate immediately.
    const deps2 = { ...deps, now: () => new Date("2026-11-02T15:00:00Z") };
    const sNy = await sellMembership(
      deps2,
      { ...C.ctx },
      { memberId: ny.id, planId: plan.id },
    );
    const sIst = await sellMembership(
      deps2,
      { ...B.ctx },
      { memberId: ist.id, planId: dayPlan.id },
    );
    await recordPayment(deps2, C.ctx, {
      memberId: ny.id,
      method: "CASH",
      amountMinor: 10_000,
    });
    await recordPayment(deps2, B.ctx, {
      memberId: ist.id,
      method: "CASH",
      amountMinor: 10_000,
    });

    // 02:00 UTC on 3 Nov: already 3 Nov in India, still 2 Nov in New York.
    const instant = new Date("2026-11-03T02:00:00Z");
    for (const gym of [B, C]) {
      await withTenant(app, gym.tenantId, async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: gym.tenantId },
        });
        await runDailyMembershipJob(
          tx,
          gym.tenantId,
          todayIn(tenant.timezone, instant),
        );
      });
    }
    const status = (gym: Gym, id: string) =>
      withTenant(
        app,
        gym.tenantId,
        async (tx) =>
          (await tx.membership.findUniqueOrThrow({ where: { id } })).status,
      );
    expect(await status(B, sIst.membership.id)).toBe("EXPIRED");
    expect(await status(C, sNy.membership.id)).toBe("ACTIVE");
    // Idempotent.
    const again = await withTenant(app, B.tenantId, (tx) =>
      runDailyMembershipJob(tx, B.tenantId, "2026-11-03"),
    );
    expect(again.expired).toBe(0);
  });
});

describe("dashboard KPIs on the demo seed data", () => {
  it("match KPI_DEFINITIONS for the seeded gym (same function as pnpm db:seed)", async () => {
    const S = await makeGym("Seeded", "08");
    await owner.$executeRaw`UPDATE app.tenant_settings SET gst_registered = true, gstin = ${GSTIN_A}, prices_include_tax = true WHERE tenant_id = ${S.tenantId}::uuid`;
    expect(
      await seedDemoMembers(deps, S.ctx, { branchId: S.branchId }),
    ).toEqual({ skipped: false, members: 5 });
    // Re-running is a no-op.
    expect(
      (await seedDemoMembers(deps, S.ctx, { branchId: S.branchId })).skipped,
    ).toBe(true);

    const metrics = await getDashboardMetrics(deps, S.ctx, {
      from: "2026-11-01",
      to: "2026-12-01",
    });
    expect(metrics).toMatchObject({
      activeMembers: 2, // Ankit (paid today) + Dev (paid 25 days ago)
      newMembers: 1, // Ankit; Dev's first membership started in October
      expiring7Days: 1, // Dev ends 2026-11-08
      invoicedMinor: 800_000, // ₹2,000 + ₹4,000 + ₹2,000 issued in November
      collectedMinor: 300_000, // ₹2,000 + ₹1,000 in November (Dev paid in October)
      outstandingMinor: 500_000, // Meera ₹3,000 + Rohan ₹2,000
    });
    // Branch filter: everything is at the main branch.
    expect(
      (
        await getDashboardMetrics(deps, S.ctx, {
          from: "2026-11-01",
          to: "2026-12-01",
          branchId: S.branchId,
        })
      ).activeMembers,
    ).toBe(2);
  });
});

describe("dashboard KPIs", () => {
  it("match KPI_DEFINITIONS on a fresh gym", async () => {
    const D = await makeGym("Delta", "08");
    const plan = await createPlan(
      deps,
      D.ctx,
      planInput({ name: "Delta Monthly", price: "1000", joiningFee: "" }),
    );
    const paid = await newMember(D, "Paid");
    const partial = await newMember(D, "Partial");
    const unpaid = await newMember(D, "Unpaid");
    await newMember(D, "NoMembership");
    for (const m of [paid, partial, unpaid])
      await sellMembership(deps, D.ctx, { memberId: m.id, planId: plan.id });
    await recordPayment(deps, D.ctx, {
      memberId: paid.id,
      method: "CASH",
      amountMinor: 100_000,
    });
    await recordPayment(deps, D.ctx, {
      memberId: partial.id,
      method: "CASH",
      amountMinor: 40_000,
    });
    await createCoupon(deps, D.ctx, {
      code: "WELCOME10",
      kind: "PERCENT",
      percent: "10",
    });

    const metrics = await getDashboardMetrics(deps, D.ctx, {
      from: "2026-11-01",
      to: "2026-12-01",
    });
    expect(metrics).toMatchObject({
      // Active = ACTIVE status (FULL_PAYMENT policy): only the fully paid one.
      activeMembers: 1,
      // New = first activated membership started in the period.
      newMembers: 1,
      expiring7Days: 0,
      // 3 × ₹1,000 invoiced; ₹1,400 paid → ₹1,600 outstanding.
      invoicedMinor: 300_000,
      collectedMinor: 140_000,
      outstandingMinor: 160_000,
    });
  });
});
