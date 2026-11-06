import type { AuthContext } from "@gym/core/authz";
import { recordPayment } from "@gym/core/billing";
import { convertLead, ensureCrmDefaults } from "@gym/core/crm";
import { createSecretBox } from "@gym/core/crypto";
import {
  decidePerk,
  ENGAGEMENT_EVENT_HANDLER,
  joinChallenge,
  myChallenges,
  myEngagement,
  myFeed,
  myReferrals,
  myRewards,
  publishAnnouncement,
  redeemPointsForCredit,
  requestPerk,
  saveChallenge,
  savePerk,
  setChallengeStatus,
  submitReferral,
} from "@gym/core/engagement";
import { noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import { dispatchEvent } from "@gym/core/events";
import {
  addMyGoal,
  assignWorkoutPlan,
  completeWorkout,
  exportMemberFitnessData,
  listExercises,
  logSet,
  memberProgress,
  memberWorkouts,
  myProgress,
  myWorkoutLog,
  myWorkoutToday,
  recordAssessment,
  saveWorkoutTemplate,
  setMyHealthConsent,
  startWorkout,
  updateWorkoutPlan,
} from "@gym/core/fitness";
import { leaveFeedback } from "@gym/core/engagement";
import {
  completeDeletion,
  createMember,
  exportMembersCsv,
  exportMyData,
  requestMyDeletion,
  resolveMemberContext,
  type MemberContext,
} from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import {
  correctFoodLog,
  logFood,
  logWater,
  myNutritionDay,
  searchFoods,
} from "@gym/core/nutrition";
import { createPlan } from "@gym/core/plans";
import { assignTrainer, upsertTrainerProfile } from "@gym/core/staff";
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

async function makeGym(name: string, plan = "pro"): Promise<Gym> {
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

let n = 0;
/** A member with an app account (member context). */
async function appMember(gym: Gym, name = "Mem") {
  n++;
  const m = await createMember(deps, gym.ctx, {
    firstName: `${name}${n}`,
    phone: `97${String(30_000_000 + n)}`,
    homeBranchId: gym.branchId,
  });
  const user = await app.user.create({
    data: {
      email: `m7member${n}@${gym.slug}.test`,
      name: `${name} ${n}`,
      emailVerified: true,
    },
  });
  await withTenant(app, gym.tenantId, (tx) =>
    tx.memberProfile.update({ where: { id: m.id }, data: { userId: user.id } }),
  );
  const mctx = (await resolveMemberContext(
    app,
    user.id,
    gym.tenantId,
  )) as MemberContext;
  return { id: m.id, mctx, phone: `+9197${String(30_000_000 + n)}` };
}

/** Runs the engagement handler for pending events of a gym (what the worker does). */
async function drainEvents(gym: Gym) {
  const rows = await owner.outbox.findMany({
    where: { tenantId: gym.tenantId, topic: "event", status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    await owner.outbox.update({
      where: { id: r.id },
      data: { status: "DONE", processedAt: new Date() },
    });
    await dispatchEvent(app, gym.tenantId, r.id, [ENGAGEMENT_EVENT_HANDLER]);
  }
  return rows.length;
}

async function checkIn(gym: Gym, memberId: string, at: Date) {
  const id = crypto.randomUUID();
  await withTenant(app, gym.tenantId, async (tx) => {
    await tx.attendanceEvent.create({
      data: {
        id,
        tenantId: gym.tenantId,
        branchId: gym.branchId,
        memberId,
        method: "MANUAL",
        result: "ACCEPTED",
        occurredAt: at,
      },
    });
    const { emitEvent } = await import("@gym/core/events");
    await emitEvent(tx, gym.tenantId, "attendance.checked_in", {
      attendanceId: id,
      memberId,
      branchId: gym.branchId,
      occurredAt: at.toISOString(),
    });
  });
}

let A: Gym;
let B: Gym;
let plan: { id: string };
let ex: Record<string, string>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  owner = createPrismaClient(db.ownerUrl);
  deps = {
    db: app,
    entitlements: noEntitlementCache,
    secrets: createSecretBox({
      key: "m7-integration-test-kek-0123456789abcdef",
    }),
    appUrl: "http://localhost:3000",
  };
  A = await makeGym("Atlas");
  B = await makeGym("Brio", "growth");
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
  const list = await listExercises(deps, A.ctx);
  ex = Object.fromEntries(
    list.filter((e) => e.libraryKey).map((e) => [e.libraryKey!, e.id]),
  );
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

const structure = () => ({
  weeks: [
    {
      days: [
        {
          title: "Lower body",
          items: [
            {
              id: "squat01",
              exerciseId: ex.barbell_back_squat,
              sets: 3,
              repsMin: 5,
              repsMax: 8,
              restSec: 120,
            },
            {
              id: "plank01",
              exerciseId: ex.plank,
              sets: 2,
              durationSec: 45,
              restSec: 30,
            },
          ],
        },
        {
          title: "Upper body",
          items: [
            {
              id: "bench01",
              exerciseId: ex.barbell_bench_press,
              sets: 3,
              repsMin: 8,
              repsMax: 10,
            },
          ],
        },
      ],
    },
  ],
});

describe("libraries", () => {
  it("each gym gets its own copy of the built-in exercise and food libraries", async () => {
    expect(Object.keys(ex).length).toBeGreaterThanOrEqual(145);
    const bList = await listExercises(deps, B.ctx);
    expect(bList.length).toBe(Object.keys(ex).length);
    expect(bList.some((e) => Object.values(ex).includes(e.id))).toBe(false);
  });
});

describe("health data: consent and access", () => {
  let trainer: AuthContext;
  let otherTrainer: AuthContext;
  let member: Awaited<ReturnType<typeof appMember>>;
  let other: Awaited<ReturnType<typeof appMember>>;
  let templateId: string;

  beforeAll(async () => {
    trainer = await addStaff(A, "TRAINER");
    otherTrainer = await addStaff(A, "TRAINER");
    const t = await upsertTrainerProfile(deps, A.ctx, trainer.userId, {
      displayName: "Coach Asha",
      specialties: "Strength",
      visibleToMembers: "on",
    });
    await upsertTrainerProfile(deps, A.ctx, otherTrainer.userId, {
      displayName: "Coach Ravi",
      specialties: "Cardio",
      visibleToMembers: "on",
    });
    member = await appMember(A, "Kiran");
    other = await appMember(A, "Lata");
    await assignTrainer(deps, A.ctx, { memberId: member.id, trainerId: t.id });
    templateId = (
      await saveWorkoutTemplate(deps, trainer, null, {
        name: "Strength basics",
        level: "BEGINNER",
        structure: structure(),
      })
    ).id;
  });

  it("nothing is stored before the member's health-data consent", async () => {
    await expectCode(
      assignWorkoutPlan(deps, trainer, member.id, { templateId }),
      "CONFLICT",
    );
    await expectCode(startWorkout(deps, member.mctx, {}), "CONFLICT");
    await setMyHealthConsent(deps, member.mctx, { granted: "on" });
    await setMyHealthConsent(deps, other.mctx, { granted: "on" });
    expect(
      await assignWorkoutPlan(deps, trainer, member.id, { templateId }),
    ).toHaveProperty("id");
  });

  it("only the assigned trainer and owner/admin see a member's data; receptionist, sales, accountant can't", async () => {
    expect((await memberWorkouts(deps, trainer, member.id)).access.via).toBe(
      "TRAINER",
    );
    await expectCode(
      memberWorkouts(deps, otherTrainer, member.id),
      "NOT_FOUND",
    );
    await expectCode(memberWorkouts(deps, trainer, other.id), "NOT_FOUND");
    for (const role of ["RECEPTIONIST", "SALES_STAFF", "ACCOUNTANT"]) {
      const staff = await addStaff(A, role);
      await expectCode(memberWorkouts(deps, staff, member.id), "FORBIDDEN");
      await expectCode(memberProgress(deps, staff, member.id), "FORBIDDEN");
    }
    const manager = await addStaff(A, "BRANCH_MANAGER", A.branchId);
    await expectCode(memberWorkouts(deps, manager, member.id), "NOT_FOUND");
    expect((await memberWorkouts(deps, A.ctx, member.id)).access.via).toBe(
      "VIEW_ALL",
    );
    // Staff reads are audited.
    const audits = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.count({
        where: { action: "fitness.workouts_viewed", entityId: member.id },
      }),
    );
    expect(audits).toBeGreaterThanOrEqual(2);
    // Another gym can't reach it at all.
    await expectCode(memberWorkouts(deps, B.ctx, member.id), "NOT_FOUND");
  });

  it("withdrawing consent stops staff access and new records", async () => {
    await setMyHealthConsent(deps, other.mctx, { granted: "" });
    await expectCode(memberWorkouts(deps, A.ctx, other.id), "CONFLICT");
    await expectCode(
      addMyGoal(deps, other.mctx, { type: "CUSTOM", title: "Run 5k" }),
      "CONFLICT",
    );
  });

  it("member logs today's workout set by set; PRs come from the logs; plan edits are versioned", async () => {
    const today = await myWorkoutToday(deps, member.mctx);
    expect(today.next).toMatchObject({ key: "w1d1", title: "Lower body" });
    const { id: logId } = await startWorkout(deps, member.mctx, {
      dayKey: "w1d1",
    });
    expect((await startWorkout(deps, member.mctx, { dayKey: "w1d1" })).id).toBe(
      logId,
    ); // one open workout
    await logSet(deps, member.mctx, logId, {
      exerciseId: ex.barbell_back_squat,
      planItemId: "squat01",
      setNumber: 1,
      reps: "5",
      weightKg: "60",
    });
    await logSet(deps, member.mctx, logId, {
      exerciseId: ex.barbell_back_squat,
      planItemId: "squat01",
      setNumber: 2,
      reps: "5",
      weightKg: "65",
    });
    await logSet(deps, member.mctx, logId, {
      exerciseId: ex.barbell_back_squat,
      planItemId: "squat01",
      setNumber: 2,
      reps: "6",
      weightKg: "65",
    }); // corrected
    await logSet(deps, member.mctx, logId, {
      exerciseId: ex.plank,
      planItemId: "plank01",
      setNumber: 1,
      durationSec: "50",
    });
    // Member B (consent given) can't touch or read member A's workout.
    await setMyHealthConsent(deps, other.mctx, { granted: "on" });
    await expectCode(
      logSet(deps, other.mctx, logId, {
        exerciseId: ex.plank,
        setNumber: 2,
        durationSec: "10",
      }),
      "NOT_FOUND",
    );
    await expectCode(myWorkoutLog(deps, other.mctx, logId), "NOT_FOUND");
    const done = await completeWorkout(deps, member.mctx, logId, {
      effort: "7",
    });
    expect(done.records.map((r) => `${r.kind}:${r.value}`).sort()).toEqual(
      [
        "EST_1RM:70",
        "EST_1RM:78",
        "MAX_DURATION:50",
        "MAX_WEIGHT:60",
        "MAX_WEIGHT:65",
      ].sort(),
    );
    await expectCode(completeWorkout(deps, member.mctx, logId), "CONFLICT");
    // A lighter day later: no new records.
    const second = await startWorkout(deps, member.mctx, { dayKey: "w1d1" });
    await logSet(deps, member.mctx, second.id, {
      exerciseId: ex.barbell_back_squat,
      setNumber: 1,
      reps: "5",
      weightKg: "50",
    });
    expect(
      (await completeWorkout(deps, member.mctx, second.id)).records,
    ).toEqual([]);
    expect((await myWorkoutToday(deps, member.mctx)).next).toMatchObject({
      key: "w1d2",
    });
    // The trainer edits the plan: version 2; the logged workouts still point at version 1.
    const planId = (await memberWorkouts(deps, trainer, member.id)).plan!.plan
      .id;
    expect(
      await updateWorkoutPlan(deps, trainer, planId, {
        structure: structure(),
        note: "More rest",
      }),
    ).toEqual({ version: 2 });
    await expectCode(
      updateWorkoutPlan(deps, otherTrainer, planId, { structure: structure() }),
      "NOT_FOUND",
    );
    const log = await myWorkoutLog(deps, member.mctx, logId);
    const v1 = await withTenant(app, A.tenantId, (tx) =>
      tx.workoutPlanVersion.findFirstOrThrow({ where: { planId, version: 1 } }),
    );
    expect(log.log.versionId).toBe(v1.id);
    // Trainer feedback reaches the member as a notification.
    await leaveFeedback(deps, trainer, member.id, {
      target: "WORKOUT_LOG",
      targetId: logId,
      body: "Great depth on the squats.",
    });
    const note = await withTenant(app, A.tenantId, (tx) =>
      tx.notification.findFirst({
        where: { templateKey: "fitness.feedback", userId: member.mctx.userId },
      }),
    );
    expect(note?.link).toBe(`/m/workouts/log/${logId}`);
    expect(
      (await myWorkoutLog(deps, member.mctx, logId)).feedback,
    ).toHaveLength(1);
  });

  it("assessments and goals: trainer records, the member sees progress; values never go into the audit log", async () => {
    await addMyGoal(deps, member.mctx, {
      type: "WEIGHT",
      title: "Reach 72 kg",
      startValue: "80",
      targetValue: "72",
    });
    await recordAssessment(deps, trainer, member.id, {
      metrics: { weightKg: 80, waistCm: 90 },
    });
    await recordAssessment(deps, trainer, member.id, {
      metrics: { weightKg: 76 },
    });
    const p = await myProgress(deps, member.mctx);
    expect(
      p.series.find((s) => s.key === "weightKg")?.points.map((x) => x.value),
    ).toEqual([80, 76]);
    expect(p.goals[0]).toMatchObject({
      title: "Reach 72 kg",
      progress: 50,
      status: "ACTIVE",
    });
    expect(p.records.length).toBeGreaterThan(0);
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { action: "fitness.assessment_recorded" },
      }),
    );
    expect(audit).toHaveLength(2);
    for (const a of audit) {
      expect([a.before, a.after]).toEqual([null, null]);
      expect(Object.keys(a.meta as object).sort()).toEqual([
        "fields",
        "memberId",
      ]);
    }
    await recordAssessment(deps, trainer, member.id, {
      metrics: { weightKg: 72 },
    });
    expect((await myProgress(deps, member.mctx)).goals[0]).toMatchObject({
      status: "ACHIEVED",
    });
  });

  it("health data is never in the general member export, only in the member's own and the fitness export", async () => {
    const csv = await withTenant(app, A.tenantId, (tx) =>
      exportMembersCsv(tx, A.ctx, { id: member.id }),
    );
    const text = typeof csv === "string" ? csv : JSON.stringify(csv);
    expect(text).not.toMatch(/weight|assessment|squat|kg/i);
    const own = await exportMyData(deps, member.mctx);
    expect(own.fitness.assessments.length).toBe(3);
    const full = await exportMemberFitnessData(deps, A.ctx, member.id);
    expect(full.json).toContain("Barbell back squat");
    await expectCode(
      exportMemberFitnessData(deps, trainer, member.id),
      "FORBIDDEN",
    );
  });

  it("deleting the member erases their health data", async () => {
    const leaving = await appMember(A, "Gone");
    await setMyHealthConsent(deps, leaving.mctx, { granted: "on" });
    await addMyGoal(deps, leaving.mctx, {
      type: "CUSTOM",
      title: "Stretch daily",
    });
    const req = await requestMyDeletion(deps, leaving.mctx, {});
    await completeDeletion(deps, A.ctx, req.id);
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.memberGoal.count({ where: { memberId: leaving.id } }),
      ),
    ).toBe(0);
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.healthDataConsent.count({ where: { memberId: leaving.id } }),
      ),
    ).toBe(2 - 1);
  });
});

describe("nutrition (estimates with source and assumptions)", () => {
  it("library × portion, source stored, member corrects, weekly summary vs target", async () => {
    const m = await appMember(A, "Neha");
    await setMyHealthConsent(deps, m.mctx, { granted: "on" });
    const roti = (await searchFoods(deps, m.mctx, "chapati")).find((f) =>
      f.name.startsWith("Chapati / roti"),
    )!;
    const r = await logFood(deps, m.mctx, {
      slot: "LUNCH",
      foodItemId: roti.id,
      servings: "2",
    });
    expect(r).toMatchObject({
      kcal: 228,
      proteinG: 7.7,
      carbsG: 39.2,
      fatG: 4.4,
    });
    const custom = await logFood(deps, m.mctx, {
      slot: "DINNER",
      name: "Homemade biryani",
      kcal: "900",
      proteinG: "10",
      carbsG: "20",
      fatG: "5",
    });
    await logWater(deps, m.mctx, { ml: "500" });
    const day = await myNutritionDay(deps, m.mctx);
    const lunch = day.day.items.find((i) => i.id === r.id)!;
    expect(lunch.source).toBe("LIBRARY");
    expect(lunch.assumptions).toContain("2 × 1 roti ≈ 80 g");
    expect(lunch.assumptions).toMatch(/estimate/);
    expect(day.day.items.find((i) => i.id === custom.id)!.assumptions).toMatch(
      /don't match/,
    );
    expect(day.day.waterMl).toBe(500);
    await correctFoodLog(deps, m.mctx, r.id, {
      kcal: "240",
      proteinG: "8",
      carbsG: "40",
      fatG: "5",
    });
    const fixed = (await myNutritionDay(deps, m.mctx)).day.items.find(
      (i) => i.id === r.id,
    )!;
    expect(fixed).toMatchObject({ kcal: 240, corrected: true });
    // Growth plan: nutrition isn't included.
    const b = await appMember(B, "Bina");
    await expectCode(myNutritionDay(deps, b.mctx), "ENTITLEMENT_REQUIRED");
  });
});

describe("streaks, points, milestones", () => {
  it("visit points once a day and only up to the weekly cap; milestones once", async () => {
    const m = await appMember(A, "Vik");
    const base = new Date("2026-11-02T03:00:00Z"); // Monday 08:30 IST
    for (let d = 0; d < 7; d++) {
      await checkIn(A, m.id, new Date(base.getTime() + d * 86_400_000));
      if (d === 0) await checkIn(A, m.id, new Date(base.getTime() + 3600_000)); // twice on day one
    }
    await drainEvents(A);
    const visitPoints = await withTenant(app, A.tenantId, (tx) =>
      tx.rewardLedger.findMany({
        where: { memberId: m.id, sourceKey: { startsWith: "visit:" } },
      }),
    );
    // 7 days visited, 8 check-ins, cap 5 rewarded days: never paid for training every day.
    expect(visitPoints).toHaveLength(5);
    // Re-running the same events changes nothing.
    const again = await owner.outbox.findMany({
      where: {
        tenantId: A.tenantId,
        topic: "event",
        payload: { path: ["data", "memberId"], equals: m.id },
      },
    });
    for (const e of again)
      await dispatchEvent(app, A.tenantId, e.id, [ENGAGEMENT_EVENT_HANDLER]);
    expect(
      await withTenant(app, A.tenantId, (tx) =>
        tx.rewardLedger.count({ where: { memberId: m.id } }),
      ),
    ).toBe(5);
    const eng = await myEngagement(deps, m.mctx);
    expect(eng.points).toBe(50);
  });
});

describe("challenges", () => {
  it("opt-in, progress by distinct days, completion points once, leaderboard by chosen names", async () => {
    const m1 = await appMember(A, "Ria");
    const m2 = await appMember(A, "Sam");
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const c = await saveChallenge(deps, A.ctx, null, {
      name: "3 visits",
      metric: "VISITS",
      target: "3",
      startsOn: iso(new Date(today.getTime() - 5 * 86_400_000)),
      endsOn: iso(new Date(today.getTime() + 5 * 86_400_000)),
      leaderboard: "on",
      points: "100",
    });
    await expectCode(
      joinChallenge(deps, m1.mctx, c.id, {
        displayName: "R",
        showOnBoard: "on",
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      joinChallenge(deps, m1.mctx, c.id, {
        displayName: "Rocket",
        showOnBoard: "on",
      }),
      "NOT_FOUND",
    ); // still a draft
    await setChallengeStatus(deps, A.ctx, c.id, "ACTIVE");
    await joinChallenge(deps, m1.mctx, c.id, {
      displayName: "Rocket",
      showOnBoard: "on",
    });
    await joinChallenge(deps, m2.mctx, c.id, {
      displayName: "Quiet one",
      showOnBoard: "",
    });
    for (let d = 3; d >= 1; d--)
      await checkIn(A, m1.id, new Date(today.getTime() - d * 86_400_000));
    await checkIn(A, m1.id, new Date(today.getTime() - 86_400_000 + 600_000)); // same day again
    await drainEvents(A);
    const mine = (await myChallenges(deps, m1.mctx)).find(
      (x) => x.id === c.id,
    )!;
    expect(mine.entry).toMatchObject({ progress: 3 });
    expect(mine.entry!.completedAt).not.toBeNull();
    expect(mine.leaderboard).toEqual([
      { rank: 1, displayName: "Rocket", progress: 3, me: true },
    ]);
    const pts = await withTenant(app, A.tenantId, (tx) =>
      tx.rewardLedger.count({
        where: { memberId: m1.id, sourceKey: `challenge:${c.id}:${m1.id}` },
      }),
    );
    expect(pts).toBe(1);
  });
});

describe("rewards", () => {
  it("redemption to member credit is atomic, never overspends, perks can be refused (points back)", async () => {
    const m = await appMember(A, "Gita");
    await withTenant(app, A.tenantId, (tx) =>
      tx.rewardLedger.create({
        data: {
          tenantId: A.tenantId,
          memberId: m.id,
          kind: "EARN",
          points: 500,
          reason: "test",
          sourceKey: `test:${m.id}`,
        },
      }),
    );
    await expectCode(
      redeemPointsForCredit(deps, m.mctx, { points: "100" }),
      "VALIDATION_FAILED",
    ); // below minimum 200
    await expectCode(
      redeemPointsForCredit(deps, m.mctx, { points: "600" }),
      "VALIDATION_FAILED",
    );
    // Two at once for 300 each: only one can go through.
    const results = await Promise.allSettled([
      redeemPointsForCredit(deps, m.mctx, { points: "300" }),
      redeemPointsForCredit(deps, m.mctx, { points: "300" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const credit = await withTenant(app, A.tenantId, (tx) =>
      tx.memberCreditEntry.findMany({
        where: { memberId: m.id, kind: "REWARD" },
      }),
    );
    expect(credit.map((c) => Number(c.amountMinor))).toEqual([15_000]); // 300 × 50 paise
    expect((await myRewards(deps, m.mctx)).balance).toBe(200);
    const perk = await savePerk(deps, A.ctx, null, {
      name: "Shaker bottle",
      pointsCost: "150",
    });
    const req = await requestPerk(deps, m.mctx, perk.id);
    expect((await myRewards(deps, m.mctx)).balance).toBe(50);
    const desk = await addStaff(A, "RECEPTIONIST");
    await decidePerk(deps, desk, req.id, {
      fulfil: false,
      note: "Out of stock",
    });
    expect((await myRewards(deps, m.mctx)).balance).toBe(200);
    await expectCode(
      decidePerk(deps, desk, req.id, { fulfil: true }),
      "CONFLICT",
    );
    const trainer = await addStaff(A, "TRAINER");
    await expectCode(
      decidePerk(deps, trainer, req.id, { fulfil: true }),
      "FORBIDDEN",
    );
  });
});

describe("referrals", () => {
  it("referral link → lead → paid membership → referrer rewarded once; referral.converted emitted", async () => {
    const referrer = await appMember(A, "Ref");
    const { code, path } = await myReferrals(deps, referrer.mctx);
    expect(path).toBe(`/r/${A.slug}/${code}`);
    expect(
      await submitReferral(deps, { slug: A.slug, code: "NOPE1234", body: {} }),
    ).toEqual({ ok: false, status: 404 });
    expect(
      await submitReferral(deps, { slug: B.slug, code, body: {} }),
    ).toEqual({ ok: false, status: 404 });
    await expectCode(
      submitReferral(deps, {
        slug: A.slug,
        code,
        body: { firstName: "Friend", phone: "9812345670" },
      }),
      "VALIDATION_FAILED",
    ); // no consent
    expect(
      await submitReferral(deps, {
        slug: A.slug,
        code: code.toLowerCase(),
        body: { firstName: "Friend", phone: "9812345670", consent: "on" },
      }),
    ).toEqual({ ok: true });
    const ref = await withTenant(app, A.tenantId, (tx) =>
      tx.referral.findFirstOrThrow({
        where: { referrerMemberId: referrer.id },
        include: { lead: { include: { source: true } } },
      }),
    );
    expect(ref.lead?.source?.code).toBe("referral");
    // The friend joins and pays.
    await withTenant(app, A.tenantId, (tx) =>
      ensureCrmDefaults(tx, A.tenantId),
    );
    const { memberId } = await convertLead(deps, A.ctx, ref.leadId!, {});
    const sale = await sellMembership(deps, A.ctx, {
      memberId,
      planId: plan.id,
      leadId: ref.leadId,
    });
    await recordPayment(deps, A.ctx, {
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
    await drainEvents(A);
    const evt = await owner.outbox.findMany({
      where: {
        tenantId: A.tenantId,
        topic: "event",
        payload: { path: ["type"], equals: "lead.converted" },
      },
    });
    for (const e of evt)
      await dispatchEvent(app, A.tenantId, e.id, [ENGAGEMENT_EVENT_HANDLER]);
    const points = await withTenant(app, A.tenantId, (tx) =>
      tx.rewardLedger.findMany({
        where: { memberId: referrer.id, sourceKey: `referral:${ref.id}` },
      }),
    );
    expect(points.map((p) => p.points)).toEqual([500]);
    expect((await myReferrals(deps, referrer.mctx)).referrals[0]).toMatchObject(
      { status: "REWARDED", rewardPoints: 500, name: "Friend" },
    );
    const converted = await owner.outbox.count({
      where: {
        tenantId: A.tenantId,
        topic: "event",
        payload: { path: ["type"], equals: "referral.converted" },
      },
    });
    expect(converted).toBe(1);
  });
});

describe("announcements", () => {
  it("branch announcements reach only that branch's members (feed + in-app)", async () => {
    const east = await withTenant(app, A.tenantId, (tx) =>
      tx.branch.create({
        data: {
          tenantId: A.tenantId,
          name: "Atlas East",
          code: "EAST",
          stateCode: "08",
        },
      }),
    );
    const here = await appMember(A, "Here");
    const there = await appMember(A, "There");
    await withTenant(app, A.tenantId, (tx) =>
      tx.memberProfile.update({
        where: { id: there.id },
        data: { homeBranchId: east.id },
      }),
    );
    const r = await publishAnnouncement(deps, A.ctx, {
      title: "Pool closed Sunday",
      body: "Maintenance work.",
      audience: "BRANCH",
      branchId: A.branchId,
    });
    expect(r.notified).toBeGreaterThanOrEqual(1);
    expect(
      (await myFeed(deps, here.mctx)).announcements.map((a) => a.title),
    ).toContain("Pool closed Sunday");
    expect(
      (await myFeed(deps, there.mctx)).announcements.map((a) => a.title),
    ).not.toContain("Pool closed Sunday");
    const desk = await addStaff(A, "RECEPTIONIST");
    await expectCode(
      publishAnnouncement(deps, desk, { title: "x x x", body: "y y y" }),
      "FORBIDDEN",
    );
  });
});
