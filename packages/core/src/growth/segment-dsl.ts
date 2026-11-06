import type { Prisma } from "@gym/db";
import { z } from "zod";
import { addDays, todayIn, toDbDate } from "../time/dates";

/**
 * Saved audiences (M6 §4). A segment is a small JSON definition over a fixed list of safe
 * fields, validated with Zod and compiled to a Prisma `where`. There is no free-text field
 * name, operator or SQL anywhere: anything not in this file is rejected, so a definition can't
 * be used to inject or to reach another tenant (RLS scopes every query anyway).
 */

const ids = z.array(z.uuid()).min(1).max(50);
const days = z.number().int().min(0).max(3650);
const tagList = z.array(z.string().trim().min(1).max(40)).min(1).max(20);
const range = z
  .object({ min: days, max: days })
  .refine((r) => r.min <= r.max, "min must be ≤ max");

export const memberConditionSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("status"),
    op: z.literal("in"),
    value: z.array(z.enum(["ACTIVE", "PENDING_APPROVAL"])).min(1),
  }),
  z.object({ field: z.literal("branch"), op: z.literal("in"), value: ids }),
  /** Has a current (active or paused) membership of one of these plans. */
  z.object({ field: z.literal("plan"), op: z.literal("in"), value: ids }),
  z.object({
    field: z.literal("membership"),
    op: z.literal("is"),
    value: z.enum(["CURRENT", "LAPSED", "NEVER"]),
  }),
  /** A current membership ends within [min, max] days from today. */
  z.object({
    field: z.literal("expiresInDays"),
    op: z.literal("between"),
    value: range,
  }),
  /** Lapsed: their last membership ended [min, max] days ago and nothing current. */
  z.object({
    field: z.literal("expiredDaysAgo"),
    op: z.literal("between"),
    value: range,
  }),
  /** gte N = no accepted check-in in the last N days; lte N = visited within N days. */
  z.object({
    field: z.literal("lastVisitDaysAgo"),
    op: z.enum(["gte", "lte"]),
    value: days.min(1),
  }),
  z.object({
    field: z.literal("tags"),
    op: z.enum(["hasAny", "hasNone"]),
    value: tagList,
  }),
  z.object({
    field: z.literal("joinedDaysAgo"),
    op: z.enum(["gte", "lte"]),
    value: days,
  }),
]);

export const leadConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("stage"), op: z.literal("in"), value: ids }),
  z.object({
    field: z.literal("leadStatus"),
    op: z.literal("in"),
    value: z.array(z.enum(["OPEN", "WON", "LOST"])).min(1),
  }),
  z.object({ field: z.literal("branch"), op: z.literal("in"), value: ids }),
  z.object({ field: z.literal("source"), op: z.literal("in"), value: ids }),
  z.object({ field: z.literal("campaign"), op: z.literal("in"), value: ids }),
  z.object({
    field: z.literal("createdDaysAgo"),
    op: z.enum(["gte", "lte"]),
    value: days,
  }),
]);

export const segmentDefinitionSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("MEMBER"),
    match: z.enum(["ALL", "ANY"]).default("ALL"),
    conditions: z.array(memberConditionSchema).max(12).default([]),
  }),
  z.object({
    entity: z.literal("LEAD"),
    match: z.enum(["ALL", "ANY"]).default("ALL"),
    conditions: z.array(leadConditionSchema).max(12).default([]),
  }),
]);

export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;
export type MemberCondition = z.infer<typeof memberConditionSchema>;
export type LeadCondition = z.infer<typeof leadConditionSchema>;

export type CompileContext = { now: Date; timeZone: string };

const CURRENT = ["ACTIVE", "PAUSED"] as const;

function memberWhere(
  c: MemberCondition,
  { now, timeZone }: CompileContext,
): Prisma.MemberProfileWhereInput {
  const today = todayIn(timeZone, now);
  switch (c.field) {
    case "status":
      return { status: { in: c.value } };
    case "branch":
      return { homeBranchId: { in: c.value } };
    case "plan":
      return {
        memberships: {
          some: { status: { in: [...CURRENT] }, planId: { in: c.value } },
        },
      };
    case "membership":
      if (c.value === "CURRENT")
        return { memberships: { some: { status: { in: [...CURRENT] } } } };
      if (c.value === "NEVER")
        return {
          memberships: {
            none: { status: { in: ["ACTIVE", "PAUSED", "EXPIRED"] } },
          },
        };
      return {
        AND: [
          { memberships: { some: { status: "EXPIRED" } } },
          {
            memberships: {
              none: { status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] } },
            },
          },
        ],
      };
    case "expiresInDays":
      return {
        memberships: {
          some: {
            status: "ACTIVE",
            endDate: {
              gte: toDbDate(addDays(today, c.value.min)),
              lte: toDbDate(addDays(today, c.value.max)),
            },
          },
        },
      };
    case "expiredDaysAgo":
      return {
        AND: [
          {
            memberships: {
              some: {
                status: "EXPIRED",
                endDate: {
                  gte: toDbDate(addDays(today, -c.value.max)),
                  lte: toDbDate(addDays(today, -c.value.min)),
                },
              },
            },
          },
          {
            memberships: {
              none: { status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] } },
            },
          },
        ],
      };
    case "lastVisitDaysAgo": {
      const since = new Date(now.getTime() - c.value * 86_400_000);
      const visits = {
        result: "ACCEPTED" as const,
        voidedAt: null,
        occurredAt: { gte: since },
      };
      return c.op === "gte"
        ? { attendance: { none: visits } }
        : { attendance: { some: visits } };
    }
    case "tags":
      return c.op === "hasAny"
        ? { tags: { hasSome: c.value } }
        : { NOT: { tags: { hasSome: c.value } } };
    case "joinedDaysAgo": {
      const at = new Date(now.getTime() - c.value * 86_400_000);
      return c.op === "lte"
        ? { joinedAt: { gte: at } }
        : { joinedAt: { lte: at } };
    }
  }
}

function leadWhere(
  c: LeadCondition,
  { now }: CompileContext,
): Prisma.LeadWhereInput {
  switch (c.field) {
    case "stage":
      return { stageId: { in: c.value } };
    case "leadStatus":
      return { status: { in: c.value } };
    case "branch":
      return { branchId: { in: c.value } };
    case "source":
      return { sourceId: { in: c.value } };
    case "campaign":
      return { campaignId: { in: c.value } };
    case "createdDaysAgo": {
      const at = new Date(now.getTime() - c.value * 86_400_000);
      return c.op === "lte"
        ? { createdAt: { gte: at } }
        : { createdAt: { lte: at } };
    }
  }
}

/** Members we can never message: archived, anonymised, or without a mobile number. */
const MEMBER_BASE: Prisma.MemberProfileWhereInput = {
  status: { not: "ARCHIVED" },
  anonymizedAt: null,
  phone: { not: null },
};
const LEAD_BASE: Prisma.LeadWhereInput = { phone: { not: null } };

export function compileMemberSegment(
  def: Extract<SegmentDefinition, { entity: "MEMBER" }>,
  ctx: CompileContext,
): Prisma.MemberProfileWhereInput {
  const parts = def.conditions.map((c) => memberWhere(c, ctx));
  if (!parts.length) return MEMBER_BASE;
  return {
    AND: [MEMBER_BASE, def.match === "ANY" ? { OR: parts } : { AND: parts }],
  };
}

export function compileLeadSegment(
  def: Extract<SegmentDefinition, { entity: "LEAD" }>,
  ctx: CompileContext,
): Prisma.LeadWhereInput {
  const parts = def.conditions.map((c) => leadWhere(c, ctx));
  if (!parts.length) return LEAD_BASE;
  return {
    AND: [LEAD_BASE, def.match === "ANY" ? { OR: parts } : { AND: parts }],
  };
}

/** Plain-language summary for lists and the launch confirmation. */
export function describeSegment(def: SegmentDefinition): string {
  if (!def.conditions.length)
    return def.entity === "MEMBER"
      ? "All members with a mobile number"
      : "All leads with a mobile number";
  const join = def.match === "ANY" ? " or " : " and ";
  const text = def.conditions.map((c) => {
    switch (c.field) {
      case "status":
        return `status is ${c.value.join("/").toLowerCase()}`;
      case "branch":
        return `${c.value.length} branch(es)`;
      case "plan":
        return `on ${c.value.length} plan(s)`;
      case "membership":
        return {
          CURRENT: "has a current membership",
          LAPSED: "membership lapsed",
          NEVER: "never had a membership",
        }[c.value];
      case "expiresInDays":
        return `membership ends in ${c.value.min}–${c.value.max} days`;
      case "expiredDaysAgo":
        return `membership ended ${c.value.min}–${c.value.max} days ago`;
      case "lastVisitDaysAgo":
        return c.op === "gte"
          ? `no visit in ${c.value}+ days`
          : `visited in the last ${c.value} days`;
      case "tags":
        return `${c.op === "hasAny" ? "tagged" : "not tagged"} ${c.value.join(", ")}`;
      case "joinedDaysAgo":
        return c.op === "lte"
          ? `joined in the last ${c.value} days`
          : `joined ${c.value}+ days ago`;
      case "stage":
        return `in ${c.value.length} stage(s)`;
      case "leadStatus":
        return `lead is ${c.value.join("/").toLowerCase()}`;
      case "source":
        return `from ${c.value.length} source(s)`;
      case "campaign":
        return `from ${c.value.length} campaign(s)`;
      case "createdDaysAgo":
        return c.op === "lte"
          ? `enquired in the last ${c.value} days`
          : `enquired ${c.value}+ days ago`;
    }
  });
  return text.join(join);
}
