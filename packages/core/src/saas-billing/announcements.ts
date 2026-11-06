import type { PrismaClient } from "@gym/db";
import { withTenant } from "@gym/db";
import { z } from "zod";
import { AppError } from "../errors";
import {
  requirePlatformPermission,
  type PlatformContext,
} from "../platform/context";
import { recordPlatformAudit } from "../platform/services";
import { parseInput } from "../validation";

/** Platform announcements to gym owners (M4 §6): banner in the gym app, by plan or status. */
const schema = z
  .object({
    title: z.string().trim().min(3, "Give it a title.").max(120),
    body: z.string().trim().min(3, "Write the message.").max(1000),
    audience: z.enum(["ALL", "PLANS", "STATUSES"]).default("ALL"),
    planCodes: z.preprocess(
      (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
      z.array(z.string().min(1).max(40)).max(20),
    ),
    statuses: z.preprocess(
      (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
      z
        .array(
          z.enum([
            "TRIALING",
            "ACTIVE",
            "PAST_DUE",
            "GRACE",
            "SUSPENDED",
            "CANCELLED",
          ]),
        )
        .max(6),
    ),
    startsAt: z.coerce.date(),
    endsAt: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.date().optional(),
    ),
  })
  .refine((v) => v.audience !== "PLANS" || v.planCodes.length > 0, {
    message: "Pick at least one plan.",
    path: ["planCodes"],
  })
  .refine((v) => v.audience !== "STATUSES" || v.statuses.length > 0, {
    message: "Pick at least one status.",
    path: ["statuses"],
  })
  .refine((v) => !v.endsAt || v.endsAt > v.startsAt, {
    message: "The end must be after the start.",
    path: ["endsAt"],
  });

export async function createAnnouncement(
  db: PrismaClient,
  ctx: PlatformContext,
  raw: unknown,
) {
  requirePlatformPermission(ctx, "platform.announcements.manage");
  const input = parseInput(schema, raw);
  return db.$transaction(async (tx) => {
    const row = await tx.announcement.create({
      data: {
        ...input,
        endsAt: input.endsAt ?? null,
        createdById: ctx.platformUserId,
      },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.announcement_created",
      entityType: "Announcement",
      entityId: row.id,
      after: { title: input.title, audience: input.audience },
    });
    return row;
  });
}

export async function archiveAnnouncement(
  db: PrismaClient,
  ctx: PlatformContext,
  id: string,
) {
  requirePlatformPermission(ctx, "platform.announcements.manage");
  const row = await db.announcement.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND", "Announcement not found.");
  await db.$transaction(async (tx) => {
    await tx.announcement.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await recordPlatformAudit(tx, ctx, {
      action: "platform.announcement_archived",
      entityType: "Announcement",
      entityId: id,
    });
  });
}

export async function listAnnouncements(
  db: PrismaClient,
  ctx: PlatformContext,
) {
  requirePlatformPermission(ctx, "platform.announcements.manage");
  return db.announcement.findMany({ orderBy: { startsAt: "desc" }, take: 100 });
}

/** Pure: is this announcement for a tenant on `planCode` with `status`, at `now`? */
export function announcementApplies(
  a: {
    audience: "ALL" | "PLANS" | "STATUSES";
    planCodes: string[];
    statuses: string[];
    startsAt: Date;
    endsAt: Date | null;
    archivedAt: Date | null;
  },
  tenant: { planCode: string | null; status: string | null },
  now: Date,
): boolean {
  if (a.archivedAt || a.startsAt > now || (a.endsAt && a.endsAt <= now))
    return false;
  if (a.audience === "PLANS")
    return !!tenant.planCode && a.planCodes.includes(tenant.planCode);
  if (a.audience === "STATUSES")
    return !!tenant.status && a.statuses.includes(tenant.status);
  return true;
}

/** Gym app (gym_app role): announcements for this tenant right now. */
export async function announcementsForTenant(
  db: PrismaClient,
  tenantId: string,
  now = new Date(),
) {
  return withTenant(db, tenantId, async (tx) => {
    const sub = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { code: true } } },
    });
    const rows = await tx.announcement.findMany({
      where: { archivedAt: null, startsAt: { lte: now } },
      orderBy: { startsAt: "desc" },
      take: 20,
    });
    return rows
      .filter((a) =>
        announcementApplies(
          a,
          { planCode: sub?.plan.code ?? null, status: sub?.status ?? null },
          now,
        ),
      )
      .map((a) => ({ id: a.id, title: a.title, body: a.body }));
  });
}
