import { withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { checkEntitlement } from "../entitlements";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import {
  entitlementsFor,
  guard,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import { fromDbDate, todayIn, toDbDate } from "../time/dates";
import { parseInput } from "../validation";
import { refreshChallengesTx } from "./hooks";

/**
 * Challenges count visit days or completed-workout days in a window (once per day). Never body
 * weight: no weight-loss leaderboards. Members opt in and choose the name shown on the board.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const challengeSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    description: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().trim().max(500).optional(),
    ),
    metric: z.enum(["VISITS", "WORKOUTS"]),
    target: z.coerce.number().int().min(1).max(366),
    startsOn: day,
    endsOn: day,
    branchId: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.uuid().optional(),
    ),
    leaderboard: z.preprocess(
      (v) => v === true || v === "on" || v === "true",
      z.boolean(),
    ),
    points: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .refine((c) => c.endsOn >= c.startsOn, {
    path: ["endsOn"],
    message: "Ends before it starts.",
  })
  .refine(
    (c) => {
      const days =
        (Date.parse(c.endsOn) - Date.parse(c.startsOn)) / 86_400_000 + 1;
      return c.target <= days;
    },
    {
      path: ["target"],
      message: "More days than the challenge lasts (each day counts once).",
    },
  );

const manage = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "engagement.manage",
    entitlement: "rewards.enabled",
    write,
  });

export async function saveChallenge(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string | null,
  raw: unknown,
) {
  await manage(deps, ctx, true);
  const input = parseInput(challengeSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const data = {
      ...input,
      description: input.description ?? null,
      branchId: input.branchId ?? null,
      startsOn: toDbDate(input.startsOn),
      endsOn: toDbDate(input.endsOn),
    };
    if (id) {
      const c = await tx.challenge.findUnique({ where: { id } });
      if (!c) throw new AppError("NOT_FOUND", "Challenge not found.");
      if (c.status !== "DRAFT")
        throw new AppError(
          "CONFLICT",
          "Only drafts can be edited (people have joined).",
        );
      await tx.challenge.update({ where: { id }, data });
      return { id };
    }
    const c = await tx.challenge.create({
      data: { tenantId: ctx.tenantId, createdById: ctx.userId, ...data },
    });
    await recordAudit(tx, ctx, {
      action: "challenge.created",
      entityType: "Challenge",
      entityId: c.id,
      after: input,
    });
    return { id: c.id };
  });
}

export async function setChallengeStatus(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
  status: "ACTIVE" | "ENDED" | "CANCELLED",
) {
  await manage(deps, ctx, true);
  return inTenant(deps, ctx, async (tx) => {
    const c = await tx.challenge.findUnique({ where: { id } });
    if (!c) throw new AppError("NOT_FOUND", "Challenge not found.");
    const transitions: Record<string, string[]> = {
      DRAFT: ["ACTIVE", "CANCELLED"],
      ACTIVE: ["ENDED", "CANCELLED"],
      ENDED: [],
      CANCELLED: [],
    };
    const allowed = transitions[c.status] ?? [];
    if (!allowed.includes(status))
      throw new AppError(
        "CONFLICT",
        `A ${c.status.toLowerCase()} challenge can't become ${status.toLowerCase()}.`,
      );
    await tx.challenge.update({ where: { id }, data: { status } });
    await recordAudit(tx, ctx, {
      action: `challenge.${status.toLowerCase()}`,
      entityType: "Challenge",
      entityId: id,
    });
  });
}

async function leaderboardTx(
  tx: TenantTransaction,
  challengeId: string,
  take = 20,
) {
  const rows = await tx.challengeParticipant.findMany({
    where: { challengeId, leftAt: null, showOnBoard: true },
    orderBy: [
      { progress: "desc" },
      { completedAt: "asc" },
      { joinedAt: "asc" },
    ],
    take,
    select: {
      id: true,
      memberId: true,
      displayName: true,
      progress: true,
      completedAt: true,
    },
  });
  let rank = 0;
  let prev = -1;
  return rows.map((r, i) => {
    if (r.progress !== prev) rank = i + 1;
    prev = r.progress;
    return { ...r, rank };
  });
}

export async function listChallenges(deps: CoreDeps, ctx: AuthContext) {
  await manage(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.challenge.findMany({
      orderBy: [{ status: "asc" }, { startsOn: "desc" }],
      include: { _count: { select: { participants: true } } },
    });
    const completed = await tx.challengeParticipant.groupBy({
      by: ["challengeId"],
      where: { completedAt: { not: null } },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      ...r,
      startsOn: fromDbDate(r.startsOn),
      endsOn: fromDbDate(r.endsOn),
      participants: r._count.participants,
      completed:
        completed.find((c) => c.challengeId === r.id)?._count._all ?? 0,
    }));
  });
}

export async function challengeDetail(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
) {
  await manage(deps, ctx);
  return inTenant(deps, ctx, async (tx) => {
    const c = await tx.challenge.findUnique({ where: { id } });
    if (!c) throw new AppError("NOT_FOUND", "Challenge not found.");
    return {
      challenge: {
        ...c,
        startsOn: fromDbDate(c.startsOn),
        endsOn: fromDbDate(c.endsOn),
      },
      leaderboard: await leaderboardTx(tx, id, 100),
    };
  });
}

// --- member -------------------------------------------------------------------------------------

async function memberTx<T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) {
  checkEntitlement(
    await entitlementsFor(deps, mctx.tenantId),
    "rewards.enabled",
  );
  return withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });
}

export async function myChallenges(deps: CoreDeps, mctx: MemberContext) {
  const today = todayIn(mctx.timezone, nowOf(deps));
  return memberTx(deps, mctx, async (tx) => {
    const me = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
      select: { homeBranchId: true },
    });
    const open = await tx.challenge.findMany({
      where: {
        status: "ACTIVE",
        endsOn: { gte: toDbDate(today) },
        OR: [{ branchId: null }, { branchId: me.homeBranchId }],
      },
      orderBy: { endsOn: "asc" },
    });
    const mine = await tx.challengeParticipant.findMany({
      where: { memberId: mctx.memberId, leftAt: null },
    });
    const out = [];
    for (const c of open) {
      const entry = mine.find((m) => m.challengeId === c.id) ?? null;
      out.push({
        ...c,
        startsOn: fromDbDate(c.startsOn),
        endsOn: fromDbDate(c.endsOn),
        entry,
        leaderboard: c.leaderboard
          ? (await leaderboardTx(tx, c.id, 10)).map((r) => ({
              rank: r.rank,
              displayName: r.displayName,
              progress: r.progress,
              me: r.memberId === mctx.memberId,
            }))
          : null,
      });
    }
    return out;
  });
}

const joinSchema = z.object({
  displayName: z.string().trim().min(2, "Pick a name for the board.").max(30),
  showOnBoard: z.preprocess(
    (v) => v === true || v === "on" || v === "true",
    z.boolean(),
  ),
});

export async function joinChallenge(
  deps: CoreDeps,
  mctx: MemberContext,
  challengeId: string,
  raw: unknown,
) {
  const input = parseInput(joinSchema, raw);
  const now = nowOf(deps);
  return memberTx(deps, mctx, async (tx) => {
    const c = await tx.challenge.findUnique({ where: { id: challengeId } });
    const today = todayIn(mctx.timezone, now);
    if (!c || c.status !== "ACTIVE" || fromDbDate(c.endsOn) < today)
      throw new AppError("NOT_FOUND", "This challenge isn't open.");
    const me = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
      select: { homeBranchId: true },
    });
    if (c.branchId && c.branchId !== me.homeBranchId)
      throw new AppError("NOT_FOUND", "This challenge isn't open.");
    await tx.challengeParticipant.upsert({
      where: {
        tenantId_challengeId_memberId: {
          tenantId: mctx.tenantId,
          challengeId,
          memberId: mctx.memberId,
        },
      },
      create: {
        tenantId: mctx.tenantId,
        challengeId,
        memberId: mctx.memberId,
        displayName: input.displayName,
        showOnBoard: input.showOnBoard,
      },
      update: {
        displayName: input.displayName,
        showOnBoard: input.showOnBoard,
        leftAt: null,
      },
    });
    // Days already in the window count (they happened during the challenge).
    await refreshChallengesTx(tx, mctx.tenantId, mctx.memberId, c.metric, now);
  });
}

export async function leaveChallenge(
  deps: CoreDeps,
  mctx: MemberContext,
  challengeId: string,
) {
  return memberTx(deps, mctx, async (tx) => {
    await tx.challengeParticipant.updateMany({
      where: { challengeId, memberId: mctx.memberId, leftAt: null },
      data: { leftAt: nowOf(deps) },
    });
  });
}
