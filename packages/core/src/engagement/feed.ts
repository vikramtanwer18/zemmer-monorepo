import { withTenant, type Prisma } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { inStaffFitness } from "../fitness/access";
import type { MemberContext } from "../members/self";
import { notify } from "../notifications";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";

// --- trainer feedback (fitness data: trainer of the member or view_all) ---------------------------

const feedbackSchema = z.object({
  target: z
    .enum(["WORKOUT_LOG", "ASSESSMENT", "NUTRITION", "GENERAL"])
    .default("GENERAL"),
  targetId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.uuid().optional(),
  ),
  body: z.string().trim().min(2, "Write the feedback.").max(1000),
});

export async function leaveFeedback(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  const input = parseInput(feedbackSchema, raw);
  return inStaffFitness(
    deps,
    ctx,
    memberId,
    "workouts.enabled",
    "write",
    async (tx) => {
      if (input.target === "WORKOUT_LOG" && input.targetId) {
        const log = await tx.workoutLog.findUnique({
          where: { id: input.targetId },
        });
        if (!log || log.memberId !== memberId)
          throw new AppError("NOT_FOUND", "Workout not found.");
      }
      if (input.target === "ASSESSMENT" && input.targetId) {
        const a = await tx.fitnessAssessment.findUnique({
          where: { id: input.targetId },
        });
        if (!a || a.memberId !== memberId)
          throw new AppError("NOT_FOUND", "Assessment not found.");
      }
      const row = await tx.trainerFeedback.create({
        data: {
          tenantId: ctx.tenantId,
          memberId,
          authorUserId: ctx.userId,
          target: input.target,
          targetId: input.targetId ?? null,
          body: input.body,
        },
      });
      const [member, author] = [
        await tx.memberProfile.findUniqueOrThrow({
          where: { id: memberId },
          select: { userId: true },
        }),
        await tx.user.findUnique({
          where: { id: ctx.userId },
          select: { name: true },
        }),
      ];
      if (member.userId)
        await notify(tx, ctx.tenantId, {
          templateKey: "fitness.feedback",
          recipient: { userId: member.userId },
          channels: ["IN_APP"],
          data: {
            trainer: author?.name ?? "Your trainer",
            preview:
              input.body.length > 140
                ? `${input.body.slice(0, 137)}…`
                : input.body,
          },
          link:
            input.target === "WORKOUT_LOG" && input.targetId
              ? `/m/workouts/log/${input.targetId}`
              : "/m/progress",
          dedupeKey: `feedback:${row.id}`,
        });
      await recordAudit(tx, ctx, {
        action: "fitness.feedback_left",
        entityType: "TrainerFeedback",
        entityId: row.id,
        meta: { memberId, target: input.target },
      });
      return { id: row.id };
    },
  );
}

export async function myFeedback(deps: CoreDeps, mctx: MemberContext) {
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      const rows = await tx.trainerFeedback.findMany({
        where: { memberId: mctx.memberId },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      const authors = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.authorUserId))] } },
        select: { id: true, name: true },
      });
      await tx.trainerFeedback.updateMany({
        where: { memberId: mctx.memberId, readAt: null },
        data: { readAt: nowOf(deps) },
      });
      return rows.map((r) => ({
        ...r,
        author: authors.find((a) => a.id === r.authorUserId)?.name ?? "Trainer",
      }));
    },
    { userId: mctx.userId },
  );
}

// --- announcements (engagement.manage) --------------------------------------------------------------

const announcementSchema = z
  .object({
    title: z.string().trim().min(3, "Give it a title.").max(100),
    body: z.string().trim().min(3, "Write the message.").max(2000),
    audience: z.enum(["ALL", "BRANCH", "PLAN"]).default("ALL"),
    branchId: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.uuid().optional(),
    ),
    planId: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.uuid().optional(),
    ),
    expiresAt: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    ),
  })
  .refine((a) => a.audience !== "BRANCH" || a.branchId, {
    path: ["branchId"],
    message: "Pick the branch.",
  })
  .refine((a) => a.audience !== "PLAN" || a.planId, {
    path: ["planId"],
    message: "Pick the plan.",
  });

function audienceWhere(a: {
  audience: string;
  branchId: string | null;
  planId: string | null;
}): Prisma.MemberProfileWhereInput {
  const base: Prisma.MemberProfileWhereInput = {
    status: "ACTIVE",
    userId: { not: null },
    anonymizedAt: null,
  };
  if (a.audience === "BRANCH") return { ...base, homeBranchId: a.branchId! };
  if (a.audience === "PLAN")
    return {
      ...base,
      memberships: {
        some: { planId: a.planId!, status: { in: ["ACTIVE", "PAUSED"] } },
      },
    };
  return base;
}

/** Posts to the member feed and sends an in-app notification to each member it's for. */
export async function publishAnnouncement(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "engagement.manage", write: true });
  const input = parseInput(announcementSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { displayName: true },
    });
    const row = await tx.gymAnnouncement.create({
      data: {
        tenantId: ctx.tenantId,
        title: input.title,
        body: input.body,
        audience: input.audience,
        branchId: input.audience === "BRANCH" ? input.branchId! : null,
        planId: input.audience === "PLAN" ? input.planId! : null,
        expiresAt: input.expiresAt
          ? new Date(`${input.expiresAt}T23:59:59Z`)
          : null,
        createdById: ctx.userId,
      },
    });
    const members = await tx.memberProfile.findMany({
      where: audienceWhere(row),
      select: { userId: true },
      take: 10_000,
    });
    for (const m of members)
      await notify(tx, ctx.tenantId, {
        templateKey: "engagement.announcement",
        recipient: { userId: m.userId },
        channels: ["IN_APP"],
        data: {
          title: input.title,
          body: input.body.slice(0, 300),
          gym: tenant.displayName,
        },
        link: "/m/feed",
        dedupeKey: `announcement:${row.id}:${m.userId}`,
      });
    await tx.gymAnnouncement.update({
      where: { id: row.id },
      data: { notified: members.length },
    });
    await recordAudit(tx, ctx, {
      action: "announcement.published",
      entityType: "GymAnnouncement",
      entityId: row.id,
      meta: { audience: input.audience, notified: members.length },
    });
    return { id: row.id, notified: members.length };
  });
}

export async function archiveAnnouncement(
  deps: CoreDeps,
  ctx: AuthContext,
  id: string,
) {
  await guard(deps, ctx, { permission: "engagement.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    await tx.gymAnnouncement.update({
      where: { id },
      data: { archivedAt: nowOf(deps) },
    });
    await recordAudit(tx, ctx, {
      action: "announcement.archived",
      entityType: "GymAnnouncement",
      entityId: id,
    });
  });
}

export async function listAnnouncements(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "engagement.manage" });
  return inTenant(deps, ctx, (tx) =>
    tx.gymAnnouncement.findMany({
      where: { archivedAt: null },
      orderBy: { publishedAt: "desc" },
      take: 100,
    }),
  );
}

/** Member feed: announcements for them (all / their branch / a plan they're on) plus trainer feedback. */
export async function myFeed(deps: CoreDeps, mctx: MemberContext) {
  const now = nowOf(deps);
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      const me = await tx.memberProfile.findUniqueOrThrow({
        where: { id: mctx.memberId },
        select: {
          homeBranchId: true,
          memberships: {
            where: { status: { in: ["ACTIVE", "PAUSED"] } },
            select: { planId: true },
          },
        },
      });
      const announcements = await tx.gymAnnouncement.findMany({
        where: {
          archivedAt: null,
          publishedAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          AND: [
            {
              OR: [
                { audience: "ALL" },
                { audience: "BRANCH", branchId: me.homeBranchId },
                {
                  audience: "PLAN",
                  planId: { in: me.memberships.map((m) => m.planId) },
                },
              ],
            },
          ],
        },
        orderBy: { publishedAt: "desc" },
        take: 30,
      });
      const unreadFeedback = await tx.trainerFeedback.count({
        where: { memberId: mctx.memberId, readAt: null },
      });
      return { announcements, unreadFeedback };
    },
    { userId: mctx.userId },
  );
}

/** Branch and plan choices for announcements and challenges (engagement.manage). */
export async function engagementOptions(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "engagement.manage" });
  return inTenant(deps, ctx, async (tx) => ({
    branches: await tx.branch.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    plans: await tx.membershipPlan.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  }));
}
