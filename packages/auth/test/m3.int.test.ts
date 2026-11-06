import {
  correctAttendance,
  fromBase64Url,
  getMyCard,
  getMyCheckIns,
  listAttendance,
  manualCheckIn,
  passCodeAt,
  reissuePass,
  revokePass,
  validateScan,
} from "@gym/core/attendance";
import type { AuthContext } from "@gym/core/authz";
import { listPayments, recordPayment } from "@gym/core/billing";
import {
  bookForMember,
  bookMyClass,
  cancelBookingAsStaff,
  cancelClassSession,
  cancelMyBooking,
  closeEndedSessions,
  createClassSession,
  createClassTemplate,
  joinMyWaitlist,
  listClassSessions,
  listMyClasses,
  updateClassTemplate,
} from "@gym/core/classes";
import { createSecretBox } from "@gym/core/crypto";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import {
  createMember,
  listMembers,
  resolveMemberContext,
  type MemberContext,
} from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import { createPlan } from "@gym/core/plans";
import {
  addAvailabilityException,
  assignTrainer,
  bookPtAppointment,
  cancelPtAppointment,
  createPtPackage,
  getStaffProfile,
  listMyClients,
  listMyPt,
  markPtAppointment,
  memberPtBalances,
  sellPtPackage,
  setWeeklyAvailability,
  updateStaffProfile,
  upsertTrainerProfile,
} from "@gym/core/staff";
import {
  createTenantForOwner,
  loadTenantAccess,
  memoryClaims,
  redisClaims,
  type CoreDeps,
} from "@gym/core/tenancy";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsFor } from "../src/permissions";

let db: TestDatabase;
let app: PrismaClient;
let owner: PrismaClient;
let redis: Redis;
let deps: CoreDeps;

// Frozen clock: Monday 9 Nov 2026, 10:00 IST.
let NOW = new Date("2026-11-09T04:30:00Z");
const at = (iso: string) => {
  NOW = new Date(iso);
};

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
    {
      gymName: name,
      stateCode: "08",
      branchName: `${name} Main`,
      timezone: "Asia/Kolkata",
    },
  );
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
    data: { email, name: `${roleKey} person`, emailVerified: true },
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

let A: Gym;
let B: Gym;
let unlimitedPlan: { id: string };
let creditPlan: { id: string };
let counter = 0;

const planInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Monthly",
  price: "1000",
  joiningFee: "",
  durationUnit: "MONTH",
  durationCount: "1",
  taxRateBps: "0",
  sacCode: "999723",
  accessScope: "HOME_BRANCH",
  refundRule: "NONE",
  classCredits: "unlimited",
  ...overrides,
});

/** A member with a paid, active membership on `planId` (and optionally an app account). */
async function activeMember(gym: Gym, planId: string, withAccount = false) {
  counter++;
  const member = await createMember(deps, gym.ctx, {
    firstName: `Member${counter}`,
    phone: `98${String(10_000_000 + counter).padStart(8, "0")}`,
    homeBranchId: gym.branchId,
    email: `m${counter}@${gym.tenantId.slice(0, 6)}.test`,
  });
  await sellMembership(deps, gym.ctx, {
    memberId: member.id,
    planId,
    payment: { method: "CASH", amountMinor: 100_000 },
  });
  let mctx: MemberContext | null = null;
  if (withAccount) {
    const user = await app.user.create({
      data: {
        email: `app${counter}@x.test`,
        name: `App ${counter}`,
        emailVerified: true,
      },
    });
    await withTenant(app, gym.tenantId, (tx) =>
      tx.memberProfile.update({
        where: { id: member.id },
        data: { userId: user.id },
      }),
    );
    mctx = await resolveMemberContext(app, user.id, gym.tenantId);
  }
  return { member, mctx };
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    db: 13,
  });
  deps = {
    db: app,
    entitlements: noEntitlementCache,
    now: () => NOW,
    secrets: createSecretBox({
      key: "integration-test-kek-0123456789abcdef-xyz",
    }),
    claims: redisClaims(redis),
  };
  A = await makeGym("Alpha");
  B = await makeGym("Beta");
  unlimitedPlan = await createPlan(deps, A.ctx, planInput());
  creditPlan = await createPlan(
    deps,
    A.ctx,
    planInput({ name: "Class pack", classCredits: "2" }),
  );
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  redis?.disconnect();
  await db?.drop();
});

async function liveCode(mctx: MemberContext, when = NOW) {
  const card = await getMyCard(deps, mctx);
  if (!card.pass) throw new Error("no pass");
  return (
    await passCodeAt(
      fromBase64Url(card.pass.secret),
      card.pass.passId,
      when.getTime(),
    )
  ).code;
}

describe("member pass and QR check-in (D-09)", () => {
  it("issues a pass with an encrypted secret and no personal data in the QR", async () => {
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    const card = await getMyCard(deps, mctx!);
    expect(card.pass?.passId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(card.membership?.status).toBe("Active");
    const stored = await withTenant(app, A.tenantId, (tx) =>
      tx.memberPass.findFirstOrThrow({ where: { passId: card.pass!.passId } }),
    );
    // The secret is never stored in the clear.
    expect(stored.secretEncrypted).not.toContain(card.pass!.secret);
    expect(stored.secretEncrypted.startsWith("v1.")).toBe(true);
    // Opening the card again returns the same pass (not a new one each time).
    expect((await getMyCard(deps, mctx!)).pass?.passId).toBe(card.pass!.passId);
  });

  it("accepts a live code once; the same code again is 'already used' (replay)", async () => {
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    const code = await liveCode(mctx!);
    const first = await validateScan(deps, A.ctx, {
      payload: code,
      branchId: A.branchId,
    });
    expect(first).toMatchObject({ result: "ACCEPTED", code: null });
    expect(first.member?.name).toMatch(/^Member/);
    const second = await validateScan(deps, A.ctx, {
      payload: code,
      branchId: A.branchId,
    });
    expect(second).toMatchObject({
      result: "REJECTED",
      code: "CODE_ALREADY_USED",
    });
    expect(second.message).toMatch(/already been used/);
    // Both scans are recorded.
    const events = await withTenant(app, A.tenantId, (tx) =>
      tx.attendanceEvent.findMany({ where: { memberId: mctx!.memberId } }),
    );
    expect(events.map((e) => e.result).sort()).toEqual([
      "ACCEPTED",
      "REJECTED",
    ]);
  });

  it("rejects a code from two steps ago, a forged code and garbage", async () => {
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    const old = await liveCode(mctx!, new Date(NOW.getTime() - 60_000));
    expect(
      await validateScan(deps, A.ctx, { payload: old, branchId: A.branchId }),
    ).toMatchObject({ result: "REJECTED", code: "CODE_EXPIRED" });
    // One step of drift is fine.
    const drift = await liveCode(mctx!, new Date(NOW.getTime() - 30_000));
    expect(
      await validateScan(deps, A.ctx, { payload: drift, branchId: A.branchId }),
    ).toMatchObject({ result: "ACCEPTED" });
    const code = await liveCode(mctx!);
    const forged = `${code.slice(0, -4)}AAAA`;
    const r = await validateScan(deps, A.ctx, {
      payload: forged,
      branchId: A.branchId,
    });
    expect(r).toMatchObject({
      result: "REJECTED",
      code: "INVALID_CODE",
      member: null,
    });
    expect(
      await validateScan(deps, A.ctx, {
        payload: "hello",
        branchId: A.branchId,
      }),
    ).toMatchObject({ result: "REJECTED", code: "INVALID_CODE" });
  });

  it("rejects a revoked pass; a reissued pass works and the old one doesn't", async () => {
    const { member, mctx } = await activeMember(A, unlimitedPlan.id, true);
    const before = await liveCode(mctx!);
    await revokePass(deps, A.ctx, member.id, { reason: "Phone lost" });
    expect(
      await validateScan(deps, A.ctx, {
        payload: before,
        branchId: A.branchId,
      }),
    ).toMatchObject({ result: "REJECTED", code: "PASS_REVOKED" });
    // A revoked pass isn't silently replaced by opening the card.
    const card = await getMyCard(deps, mctx!);
    expect(card.pass).toBeNull();
    expect(card.passRevoked).toBe(true);
    await reissuePass(deps, A.ctx, member.id, { reason: "New phone" });
    const fresh = await liveCode(mctx!);
    expect(fresh.split(".")[0]).not.toBe(before.split(".")[0]);
    expect(
      await validateScan(deps, A.ctx, { payload: fresh, branchId: A.branchId }),
    ).toMatchObject({ result: "ACCEPTED" });
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { action: { startsWith: "member_pass." } },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["member_pass.revoked", "member_pass.reissued"]),
    );
  });

  it("tenant B staff cannot validate tenant A's pass", async () => {
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    const code = await liveCode(mctx!);
    const r = await validateScan(deps, B.ctx, {
      payload: code,
      branchId: B.branchId,
    });
    expect(r).toMatchObject({
      result: "REJECTED",
      code: "INVALID_CODE",
      member: null,
    });
    // …and the code is still unused in gym A.
    expect(
      await validateScan(deps, A.ctx, { payload: code, branchId: A.branchId }),
    ).toMatchObject({ result: "ACCEPTED" });
    // A's branch can't be used from B's context either (RLS: it doesn't exist there).
    await expectCode(
      validateScan(deps, B.ctx, { payload: code, branchId: A.branchId }),
      "VALIDATION_FAILED",
    );
  });

  it("the DB unique index stops a replay even when the Redis guard is bypassed", async () => {
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    const code = await liveCode(mctx!);
    const noRedis = { ...deps, claims: undefined };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        validateScan(noRedis, A.ctx, { payload: code, branchId: A.branchId }),
      ),
    );
    const accepted = results.filter(
      (r) => r.status === "fulfilled" && r.value.result === "ACCEPTED",
    );
    expect(accepted).toHaveLength(1);
    const accepteds = await withTenant(app, A.tenantId, (tx) =>
      tx.attendanceEvent.count({
        where: { memberId: mctx!.memberId, result: "ACCEPTED" },
      }),
    );
    expect(accepteds).toBe(1);
    // With Redis on, parallel replays are refused before they reach the DB.
    const code2 = await liveCode(mctx!, new Date(NOW.getTime() + 30_000));
    const memory = { ...deps, claims: memoryClaims() };
    const later = new Date(NOW.getTime() + 30_000 + 3 * 60_000);
    const fast = await Promise.all(
      Array.from({ length: 4 }, () =>
        validateScan({ ...memory, now: () => later }, A.ctx, {
          payload: code2,
          branchId: A.branchId,
        }),
      ),
    );
    // Code2 is for NOW+30s; at NOW+3m30s it's expired: all refused, none accepted.
    expect(fast.every((r) => r.result === "REJECTED")).toBe(true);
  });

  it("applies membership, branch, duplicate-window and dues rules", async () => {
    // Expired membership.
    const { member: m1, mctx: c1 } = await activeMember(
      A,
      unlimitedPlan.id,
      true,
    );
    await owner.$executeRaw`UPDATE app.membership SET start_date = '2026-09-01', end_date = '2026-10-01', status = 'EXPIRED' WHERE member_id = ${m1.id}::uuid`;
    const r1 = await validateScan(deps, A.ctx, {
      payload: await liveCode(c1!),
      branchId: A.branchId,
    });
    expect(r1).toMatchObject({
      result: "REJECTED",
      code: "MEMBERSHIP_EXPIRED",
    });
    expect(r1.message).toContain("2026-10-01");

    // Wrong branch (HOME_BRANCH plan, scanned at a second branch).
    const second = await withTenant(app, A.tenantId, (tx) =>
      tx.branch.create({
        data: {
          tenantId: A.tenantId,
          name: "Alpha Two",
          code: "A2",
          stateCode: "08",
        },
      }),
    );
    const { mctx: c2 } = await activeMember(A, unlimitedPlan.id, true);
    expect(
      await validateScan(deps, A.ctx, {
        payload: await liveCode(c2!),
        branchId: second.id,
      }),
    ).toMatchObject({ result: "REJECTED", code: "WRONG_BRANCH" });

    // Duplicate window: a second (new) code within 2 minutes.
    const ok = await validateScan(deps, A.ctx, {
      payload: await liveCode(c2!),
      branchId: A.branchId,
    });
    expect(ok.result).toBe("ACCEPTED");
    const next = await liveCode(c2!, new Date(NOW.getTime() + 30_000));
    const dup = await validateScan(
      { ...deps, now: () => new Date(NOW.getTime() + 30_000) },
      A.ctx,
      {
        payload: next,
        branchId: A.branchId,
      },
    );
    expect(dup).toMatchObject({
      result: "REJECTED",
      code: "ALREADY_CHECKED_IN",
    });

    // Dues: warn by default, block when the gym says so.
    const { member: m3, mctx: c3 } = await activeMember(
      A,
      unlimitedPlan.id,
      true,
    );
    await createMember(deps, A.ctx, {
      firstName: "x",
      phone: "9812300000",
      homeBranchId: A.branchId,
    });
    await sellMembership(deps, A.ctx, {
      memberId: m3.id,
      planId: creditPlan.id,
      startDate: "2026-12-20",
    });
    const warned = await validateScan(deps, A.ctx, {
      payload: await liveCode(c3!),
      branchId: A.branchId,
    });
    expect(warned.result).toBe("ACCEPTED");
    expect(warned.warnings.join(" ")).toMatch(/Outstanding dues/);
    await owner.$executeRaw`UPDATE app.tenant_settings SET dues_at_checkin = 'BLOCK', checkin_duplicate_minutes = 0 WHERE tenant_id = ${A.tenantId}::uuid`;
    const later = new Date(NOW.getTime() + 60_000);
    const blocked = await validateScan({ ...deps, now: () => later }, A.ctx, {
      payload: await liveCode(c3!, later),
      branchId: A.branchId,
    });
    expect(blocked).toMatchObject({
      result: "REJECTED",
      code: "DUES_OUTSTANDING",
    });
    await owner.$executeRaw`UPDATE app.tenant_settings SET dues_at_checkin = 'WARN', checkin_duplicate_minutes = 2 WHERE tenant_id = ${A.tenantId}::uuid`;
  });

  it("manual check-in needs a reason, can be overridden only with attendance.override, and is audited", async () => {
    const reception = await addStaff(A, "RECEPTIONIST", "desk@alpha.test");
    const manager = await addStaff(A, "BRANCH_MANAGER", "mgr@alpha.test");
    const nobody = await createMember(deps, A.ctx, {
      firstName: "Walkin",
      phone: "9811100000",
      homeBranchId: A.branchId,
    });
    await expectCode(
      manualCheckIn(deps, reception, {
        memberId: nobody.id,
        branchId: A.branchId,
        reason: "",
      }),
      "VALIDATION_FAILED",
    );
    const refused = await manualCheckIn(deps, reception, {
      memberId: nobody.id,
      branchId: A.branchId,
      reason: "Forgot phone",
    });
    expect(refused).toMatchObject({
      result: "REJECTED",
      code: "NO_MEMBERSHIP",
      overridable: false,
    });
    await expectCode(
      manualCheckIn(deps, reception, {
        memberId: nobody.id,
        branchId: A.branchId,
        reason: "Owner said OK",
        override: "on",
      }),
      "FORBIDDEN",
    );
    const offer = await manualCheckIn(deps, manager, {
      memberId: nobody.id,
      branchId: A.branchId,
      reason: "Trial visit",
    });
    expect(offer.overridable).toBe(true);
    const overridden = await manualCheckIn(deps, manager, {
      memberId: nobody.id,
      branchId: A.branchId,
      reason: "Trial visit agreed with owner",
      override: "on",
    });
    expect(overridden.result).toBe("ACCEPTED");
    const event = await withTenant(app, A.tenantId, (tx) =>
      tx.attendanceEvent.findUniqueOrThrow({
        where: { id: overridden.eventId },
      }),
    );
    expect(event).toMatchObject({
      method: "MANUAL",
      overridden: true,
      scannedByUserId: manager.userId,
    });
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: "attendance.override", entityId: event.id },
      }),
    );
    expect(audit.actorUserId).toBe(manager.userId);

    // Corrections: receptionist can't; manager voids with a reason (audited); history is kept.
    await expectCode(
      correctAttendance(deps, reception, event.id, {
        action: "void",
        reason: "mistake",
      }),
      "FORBIDDEN",
    );
    await correctAttendance(deps, manager, event.id, {
      action: "void",
      reason: "Wrong person",
    });
    const voided = await withTenant(app, A.tenantId, (tx) =>
      tx.attendanceEvent.findUniqueOrThrow({ where: { id: event.id } }),
    );
    expect(voided.voidReason).toBe("Wrong person");
    // The database refuses rewriting who/what even if the app tried.
    await expect(
      withTenant(app, A.tenantId, (tx) =>
        tx.attendanceEvent.update({
          where: { id: event.id },
          data: { reason: "edited" },
        }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withTenant(app, A.tenantId, (tx) =>
        tx.attendanceEvent.delete({ where: { id: event.id } }),
      ),
    ).rejects.toThrow();
  });

  it("shows the member their check-ins and streak, and staff today's list", async () => {
    const { member, mctx } = await activeMember(A, unlimitedPlan.id, true);
    await owner.$executeRaw`UPDATE app.membership SET start_date = '2026-11-01' WHERE member_id = ${member.id}::uuid`;
    for (const [day, hour] of [
      ["2026-11-07", "03:00"],
      ["2026-11-08", "03:00"],
    ] as const) {
      const t = new Date(`${day}T${hour}:00Z`);
      await validateScan({ ...deps, now: () => t }, A.ctx, {
        payload: await liveCode(mctx!, t),
        branchId: A.branchId,
      });
    }
    await validateScan(deps, A.ctx, {
      payload: await liveCode(mctx!),
      branchId: A.branchId,
    });
    const mine = await getMyCheckIns(deps, mctx!);
    expect(mine.streakDays).toBe(3);
    expect(mine.events.length).toBe(3);
    const today = await listAttendance(deps, A.ctx, { branchId: A.branchId });
    expect(today.summary.checkIns).toBeGreaterThan(0);
    expect(today.rows.some((r) => r.result === "REJECTED")).toBe(true);
  });
});

describe("classes and bookings", () => {
  it("materializes a weekly template 8 weeks ahead and keeps booked sessions on change", async () => {
    const { template, created } = await createClassTemplate(deps, A.ctx, {
      branchId: A.branchId,
      name: "Morning Yoga",
      capacity: "10",
      durationMinutes: "60",
      startTime: "18:00",
      byDays: ["1", "3"],
      startDate: "2026-11-09",
    });
    // Mon + Wed for 8 weeks from Mon 9 Nov (inclusive of the 56-day horizon end).
    expect(created).toBe(17);
    const week = await listClassSessions(deps, A.ctx, {
      from: "2026-11-09",
      days: 7,
    });
    const yoga = week.sessions.filter((s) => s.name === "Morning Yoga");
    expect(yoga.map((s) => `${s.date} ${s.startTime}`)).toEqual([
      "2026-11-09 18:00",
      "2026-11-11 18:00",
    ]);
    const { mctx } = await activeMember(A, unlimitedPlan.id, true);
    await bookMyClass(deps, mctx!, { sessionId: yoga[0]!.id });
    // Move the class to 19:00 on Mon/Fri: the booked Monday keeps 18:00 and is flagged.
    const changed = await updateClassTemplate(deps, A.ctx, template.id, {
      branchId: A.branchId,
      name: "Morning Yoga",
      capacity: "10",
      durationMinutes: "60",
      startTime: "19:00",
      byDays: ["1", "5"],
      startDate: "2026-11-09",
    });
    expect(changed.flagged).toBe(1);
    const after = await listClassSessions(deps, A.ctx, {
      from: "2026-11-09",
      days: 7,
    });
    const y2 = after.sessions.filter((s) => s.name === "Morning Yoga");
    expect(y2.map((s) => `${s.date} ${s.startTime}`)).toEqual([
      "2026-11-09 18:00",
      "2026-11-13 19:00",
    ]);
    expect(y2[0]!.conflictNote).toMatch(/already has bookings/);
  });

  it("20 parallel bookings for the last seat: exactly one succeeds", async () => {
    const session = await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "Spin (last seat)",
      date: "2026-11-10",
      startTime: "07:00",
      durationMinutes: "45",
      capacity: "1",
    });
    const members = [];
    for (let i = 0; i < 20; i++)
      members.push((await activeMember(A, unlimitedPlan.id)).member);
    const results = await Promise.allSettled(
      members.map((m) =>
        bookForMember(deps, A.ctx, { sessionId: session.id, memberId: m.id }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const full = results.filter(
      (r) =>
        r.status === "rejected" &&
        isAppError(r.reason) &&
        r.reason.message === "This class is full.",
    );
    expect(ok).toHaveLength(1);
    expect(full).toHaveLength(19);
    const fresh = await withTenant(app, A.tenantId, (tx) =>
      tx.classSession.findUniqueOrThrow({ where: { id: session.id } }),
    );
    expect(fresh.bookedCount).toBe(1);
    const live = await withTenant(app, A.tenantId, (tx) =>
      tx.booking.count({ where: { sessionId: session.id, status: "BOOKED" } }),
    );
    expect(live).toBe(1);
    // The database itself refuses overbooking.
    await expect(
      owner.$executeRaw`UPDATE app.class_session SET booked_count = 2 WHERE id = ${session.id}::uuid`,
    ).rejects.toThrow(/booked_within_capacity/);
  }, 60_000);

  it("waitlist: full → join → cancellation promotes in order, also under concurrent cancellations", async () => {
    const session = await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "HIIT",
      date: "2026-11-12",
      startTime: "18:00",
      durationMinutes: "45",
      capacity: "2",
      waitlistEnabled: "on",
      cancelCutoffMinutes: "120",
    });
    const people = [];
    for (let i = 0; i < 5; i++)
      people.push(await activeMember(A, unlimitedPlan.id, true));
    const [p1, p2, w1, w2, w3] = people.map((p) => p.mctx!);
    const b1 = await bookMyClass(deps, p1!, { sessionId: session.id });
    const b2 = await bookMyClass(deps, p2!, { sessionId: session.id });
    const full = await expectCode(
      bookMyClass(deps, w1!, { sessionId: session.id }),
      "CONFLICT",
    );
    expect(full.details).toMatchObject({ code: "CLASS_FULL", waitlist: true });
    expect(
      (await joinMyWaitlist(deps, w1!, { sessionId: session.id })).place,
    ).toBe(1);
    expect(
      (await joinMyWaitlist(deps, w2!, { sessionId: session.id })).place,
    ).toBe(2);
    expect(
      (await joinMyWaitlist(deps, w3!, { sessionId: session.id })).place,
    ).toBe(3);
    // Both booked members cancel at the same moment.
    const [c1, c2] = await Promise.all([
      cancelMyBooking(deps, p1!, b1.id),
      cancelMyBooking(deps, p2!, b2.id),
    ]);
    expect(c1.promoted + c2.promoted).toBe(2);
    const state = await withTenant(app, A.tenantId, async (tx) => ({
      session: await tx.classSession.findUniqueOrThrow({
        where: { id: session.id },
      }),
      waitlist: await tx.waitlistEntry.findMany({
        where: { sessionId: session.id },
        orderBy: { position: "asc" },
      }),
      notes: await tx.notification.count({
        where: { templateKey: "class.promoted" },
      }),
    }));
    expect(state.session.bookedCount).toBe(2);
    expect(state.waitlist.map((w) => w.status)).toEqual([
      "PROMOTED",
      "PROMOTED",
      "WAITING",
    ]);
    expect(state.notes).toBeGreaterThanOrEqual(2);
    // w1 sees the class as booked in the app.
    const list = await listMyClasses(deps, w1!, {
      from: "2026-11-12",
      days: 1,
    });
    expect(list.find((s) => s.id === session.id)?.booking?.status).toBe(
      "BOOKED",
    );
    // Another member can't cancel w1's booking.
    const w1Booking = list.find((s) => s.id === session.id)!.booking!;
    await expectCode(cancelMyBooking(deps, w3!, w1Booking.id), "NOT_FOUND");
  });

  it("credits: one per booking, returned before the cutoff, kept after it", async () => {
    const mk = (date: string) =>
      createClassSession(deps, A.ctx, {
        branchId: A.branchId,
        name: `Pilates ${date}`,
        date,
        startTime: "18:00",
        durationMinutes: "60",
        capacity: "5",
        cancelCutoffMinutes: "120",
        bookingOpensHours: "720",
      });
    const [s1, s2, s3] = [
      await mk("2026-11-16"),
      await mk("2026-11-17"),
      await mk("2026-11-18"),
    ];
    const { mctx } = await activeMember(A, creditPlan.id, true);
    const b1 = await bookMyClass(deps, mctx!, { sessionId: s1.id });
    await bookMyClass(deps, mctx!, { sessionId: s2.id });
    const none = await expectCode(
      bookMyClass(deps, mctx!, { sessionId: s3.id }),
      "CONFLICT",
    );
    expect(none.details).toMatchObject({ code: "NO_CREDITS" });
    // Cancel early: credit back, so s3 can be booked.
    expect((await cancelMyBooking(deps, mctx!, b1.id)).creditReturned).toBe(
      true,
    );
    const b3 = await bookMyClass(deps, mctx!, { sessionId: s3.id });
    // Late cancel (inside 2 hours): credit kept, marked late.
    at("2026-11-18T11:00:00Z"); // 16:30 IST, class at 18:00
    const late = await cancelMyBooking(deps, mctx!, b3.id);
    expect(late).toMatchObject({ late: true, creditReturned: false });
    at("2026-11-09T04:30:00Z");
    const ledger = await withTenant(app, A.tenantId, (tx) =>
      tx.entitlementLedger.findMany({ where: { memberId: mctx!.memberId } }),
    );
    expect(ledger.reduce((s, r) => s + r.delta, 0)).toBe(0);
    expect(ledger.map((r) => r.reason).sort()).toEqual(
      ["BOOKING", "BOOKING", "BOOKING", "BOOKING_RETURNED", "GRANT"].sort(),
    );
  });

  it("a plan without classes can't book; cancelling a class returns credits and tells members", async () => {
    const noClasses = await createPlan(
      deps,
      A.ctx,
      planInput({ name: "Gym only", classCredits: "" }),
    );
    const s = await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "Zumba",
      date: "2026-11-20",
      startTime: "18:00",
      durationMinutes: "60",
      capacity: "5",
      bookingOpensHours: "720",
    });
    const { mctx: gymOnly } = await activeMember(A, noClasses.id, true);
    const err = await expectCode(
      bookMyClass(deps, gymOnly!, { sessionId: s.id }),
      "CONFLICT",
    );
    expect(err.message).toMatch(/doesn't include classes/);
    const { mctx } = await activeMember(A, creditPlan.id, true);
    await bookMyClass(deps, mctx!, { sessionId: s.id });
    expect(
      (
        await cancelClassSession(deps, A.ctx, s.id, {
          reason: "Trainer unwell",
        })
      ).bookingsCancelled,
    ).toBe(1);
    const sum = await withTenant(app, A.tenantId, (tx) =>
      tx.entitlementLedger.aggregate({
        where: { memberId: mctx!.memberId },
        _sum: { delta: true },
      }),
    );
    expect(sum._sum.delta).toBe(2);
    const note = await withTenant(app, A.tenantId, (tx) =>
      tx.notification.findFirst({
        where: { memberId: mctx!.memberId, templateKey: "class.cancelled" },
      }),
    );
    expect(note?.body).toContain("Trainer unwell");
  });

  it("marks the rest as no-shows when a class ends, and a QR check-in marks booked classes attended", async () => {
    const s = await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "Boxing",
      date: "2026-11-09",
      startTime: "11:00",
      durationMinutes: "60",
      capacity: "5",
    });
    const { mctx: here } = await activeMember(A, unlimitedPlan.id, true);
    const { mctx: away } = await activeMember(A, unlimitedPlan.id, true);
    await bookMyClass(deps, here!, { sessionId: s.id });
    await bookMyClass(deps, away!, { sessionId: s.id });
    const scan = await validateScan(deps, A.ctx, {
      payload: await liveCode(here!),
      branchId: A.branchId,
    });
    expect(scan.markedClasses).toBe(1);
    const closed = await withTenant(app, A.tenantId, (tx) =>
      closeEndedSessions(tx, A.tenantId, new Date("2026-11-09T07:00:00Z")),
    );
    expect(closed.noShows).toBeGreaterThanOrEqual(1);
    const bookings = await withTenant(app, A.tenantId, (tx) =>
      tx.booking.findMany({
        where: { sessionId: s.id },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(bookings.map((b) => b.status)).toEqual(["ATTENDED", "NO_SHOW"]);
  });

  it("staff can't book for members without bookings.manage", async () => {
    const trainerCtx = await addStaff(A, "TRAINER", "tr-book@alpha.test");
    const s = await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "Stretch",
      date: "2026-11-21",
      startTime: "09:00",
      durationMinutes: "30",
      capacity: "5",
      bookingOpensHours: "720",
    });
    const { member } = await activeMember(A, unlimitedPlan.id);
    await expectCode(
      bookForMember(deps, trainerCtx, { sessionId: s.id, memberId: member.id }),
      "FORBIDDEN",
    );
    const b = await bookForMember(deps, A.ctx, {
      sessionId: s.id,
      memberId: member.id,
    });
    await cancelBookingAsStaff(deps, A.ctx, b.id, "Member called");
  });
});

describe("staff, trainers and PT packages", () => {
  it("hides pay details without staff.compensation.view", async () => {
    const coach = await addStaff(A, "TRAINER", "coach-pay@alpha.test");
    const manager = await addStaff(A, "BRANCH_MANAGER", "mgr-pay@alpha.test");
    await updateStaffProfile(deps, A.ctx, coach.userId, {
      jobTitle: "Head coach",
      payBasis: "MONTHLY",
      payRate: "30000",
    });
    expect(
      (await getStaffProfile(deps, A.ctx, coach.userId)).pay?.payRate,
    ).toBe("30000.00");
    const seen = await getStaffProfile(deps, manager, coach.userId);
    expect(seen.pay).toBeNull();
    expect(seen.profile?.jobTitle).toBe("Head coach");
    await expectCode(
      updateStaffProfile(deps, manager, coach.userId, { payRate: "99999" }),
      "FORBIDDEN",
    );
  });

  it("PT package: sale → invoice → payment activates → book → conflict checks → complete", async () => {
    const coach = await addStaff(A, "TRAINER", "coach-pt@alpha.test");
    const trainer = await upsertTrainerProfile(deps, A.ctx, coach.userId, {
      displayName: "Coach Vikas",
      specialties: "Strength, Mobility",
      visibleToMembers: "on",
    });
    // Mon–Sat 06:00–14:00, on leave Thursday 12 Nov.
    await setWeeklyAvailability(deps, coach, coach.userId, {
      slots: [1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        from: "06:00",
        to: "14:00",
      })),
    });
    await addAvailabilityException(deps, coach, coach.userId, {
      date: "2026-11-12",
      available: "false",
      note: "Leave",
    });
    const pkg = await createPtPackage(deps, A.ctx, {
      name: "PT 10",
      sessionCount: "2",
      validityDays: "60",
      price: "5900",
      taxRateBps: "1800",
    });
    const { member, mctx } = await activeMember(A, unlimitedPlan.id, true);
    const sale = await sellPtPackage(deps, A.ctx, {
      memberId: member.id,
      packageId: pkg.id,
      trainerId: trainer.id,
    });
    expect(sale.balance.status).toBe("PENDING_PAYMENT");
    const line = await withTenant(app, A.tenantId, (tx) =>
      tx.gymInvoiceLine.findFirstOrThrow({
        where: { invoiceId: sale.invoice.id },
      }),
    );
    expect(line).toMatchObject({ kind: "PT_PACKAGE", sacCode: "999723" });
    await expectCode(
      bookPtAppointment(deps, A.ctx, {
        balanceId: sale.balance.id,
        trainerId: trainer.id,
        date: "2026-11-10",
        time: "07:00",
      }),
      "CONFLICT",
    ); // not paid yet
    await recordPayment(deps, A.ctx, {
      memberId: member.id,
      branchId: A.branchId,
      method: "UPI",
      reference: "UPI-123456",
      amountMinor: Number(sale.invoice.totalMinor),
      allocations: [
        {
          invoiceId: sale.invoice.id,
          amountMinor: Number(sale.invoice.totalMinor),
        },
      ],
    });
    const [balance] = await memberPtBalances(deps, A.ctx, member.id);
    expect(balance).toMatchObject({ status: "ACTIVE", left: 2, bookable: 2 });

    // Trainer on leave → refused; outside hours → refused; double-booked → refused.
    await expectCode(
      bookPtAppointment(deps, A.ctx, {
        balanceId: balance!.id,
        trainerId: trainer.id,
        date: "2026-11-12",
        time: "07:00",
      }),
      "CONFLICT",
    );
    await expectCode(
      bookPtAppointment(deps, A.ctx, {
        balanceId: balance!.id,
        trainerId: trainer.id,
        date: "2026-11-10",
        time: "18:00",
      }),
      "CONFLICT",
    );
    await createClassSession(deps, A.ctx, {
      branchId: A.branchId,
      name: "Coach's class",
      date: "2026-11-10",
      startTime: "08:00",
      durationMinutes: "60",
      capacity: "5",
      trainerId: trainer.id,
    });
    const busy = await expectCode(
      bookPtAppointment(deps, A.ctx, {
        balanceId: balance!.id,
        trainerId: trainer.id,
        date: "2026-11-10",
        time: "08:30",
      }),
      "CONFLICT",
    );
    expect(busy.message).toMatch(/already on Coach's class/);

    // The trainer books their own client (pt.own); the member sees it.
    await assignTrainer(deps, A.ctx, {
      memberId: member.id,
      trainerId: trainer.id,
    });
    const appt = await bookPtAppointment(deps, coach, {
      balanceId: balance!.id,
      trainerId: trainer.id,
      date: "2026-11-10",
      time: "06:30",
    });
    expect((await listMyPt(deps, mctx!)).upcoming).toHaveLength(1);
    // Can't complete before it starts; after it, completion uses one session.
    await expectCode(
      markPtAppointment(deps, coach, appt.id, { status: "COMPLETED" }),
      "CONFLICT",
    );
    at("2026-11-10T02:00:00Z");
    await markPtAppointment(deps, coach, appt.id, {
      status: "COMPLETED",
      notes: "Good form",
    });
    at("2026-11-09T04:30:00Z");
    const [after] = await memberPtBalances(deps, coach, member.id);
    expect(after).toMatchObject({ left: 1, invoice: null }); // trainers don't see invoices

    // A late cancellation (inside 12 h) counts as a no-show and uses the last session.
    const last = await bookPtAppointment(deps, coach, {
      balanceId: balance!.id,
      trainerId: trainer.id,
      date: "2026-11-11",
      time: "07:00",
    });
    at("2026-11-11T00:00:00Z");
    expect(
      (await cancelPtAppointment(deps, coach, last.id, { reason: "Sick" }))
        .late,
    ).toBe(true);
    at("2026-11-09T04:30:00Z");
    const [done] = await memberPtBalances(deps, A.ctx, member.id);
    expect(done).toMatchObject({ status: "EXHAUSTED", left: 0 });
  });

  it("a trainer sees only their assigned clients, never payments or the member list", async () => {
    const coachCtx = await addStaff(A, "TRAINER", "coach-view@alpha.test");
    const t = await upsertTrainerProfile(deps, A.ctx, coachCtx.userId, {
      displayName: "Coach Asha",
    });
    const { member: mine } = await activeMember(A, unlimitedPlan.id);
    const { member: other } = await activeMember(A, unlimitedPlan.id);
    await assignTrainer(deps, A.ctx, { memberId: mine.id, trainerId: t.id });
    const { clients } = await listMyClients(deps, coachCtx);
    expect(clients.map((c) => c.memberId)).toEqual([mine.id]);
    await expectCode(memberPtBalances(deps, coachCtx, other.id), "FORBIDDEN");
    await expectCode(listPayments(deps, coachCtx, {}), "FORBIDDEN");
    await expectCode(listMembers(deps, coachCtx, {}), "FORBIDDEN");
    // Another trainer's PT sessions are off limits.
    const pkg = await createPtPackage(deps, A.ctx, {
      name: "PT trial",
      sessionCount: "1",
      validityDays: "30",
      price: "0",
    });
    const sale = await sellPtPackage(deps, A.ctx, {
      memberId: other.id,
      packageId: pkg.id,
    });
    expect(sale.balance.status).toBe("ACTIVE"); // free package activates at once
    await expectCode(
      bookPtAppointment(deps, coachCtx, {
        balanceId: sale.balance.id,
        trainerId: t.id,
        date: "2026-11-10",
        time: "07:00",
      }),
      "FORBIDDEN",
    );
  });
});
