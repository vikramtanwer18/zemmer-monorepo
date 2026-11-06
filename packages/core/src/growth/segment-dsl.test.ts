import { describe, expect, it } from "vitest";
import {
  compileLeadSegment,
  compileMemberSegment,
  describeSegment,
  segmentDefinitionSchema,
} from "./segment-dsl";

const ctx = { now: new Date("2026-11-05T06:30:00Z"), timeZone: "Asia/Kolkata" };
const id = "7d4b2c1e-0b8a-4c55-9a43-2f1e5f2c9a10";

describe("segment DSL", () => {
  it("compiles member conditions to a Prisma where over whitelisted fields", () => {
    const def = segmentDefinitionSchema.parse({
      entity: "MEMBER",
      conditions: [
        { field: "expiresInDays", op: "between", value: { min: 0, max: 7 } },
        { field: "lastVisitDaysAgo", op: "gte", value: 14 },
        { field: "tags", op: "hasNone", value: ["vip"] },
      ],
    });
    if (def.entity !== "MEMBER") throw new Error();
    const where = compileMemberSegment(def, ctx);
    expect(where).toEqual({
      AND: [
        {
          status: { not: "ARCHIVED" },
          anonymizedAt: null,
          phone: { not: null },
        },
        {
          AND: [
            {
              memberships: {
                some: {
                  status: "ACTIVE",
                  endDate: {
                    gte: new Date("2026-11-05T00:00:00Z"),
                    lte: new Date("2026-11-12T00:00:00Z"),
                  },
                },
              },
            },
            {
              attendance: {
                none: {
                  result: "ACCEPTED",
                  voidedAt: null,
                  occurredAt: {
                    gte: new Date(ctx.now.getTime() - 14 * 86_400_000),
                  },
                },
              },
            },
            { NOT: { tags: { hasSome: ["vip"] } } },
          ],
        },
      ],
    });
  });

  it("ANY becomes OR; an empty definition still excludes the unreachable", () => {
    const def = segmentDefinitionSchema.parse({
      entity: "LEAD",
      match: "ANY",
      conditions: [
        { field: "leadStatus", op: "in", value: ["OPEN"] },
        { field: "source", op: "in", value: [id] },
      ],
    });
    if (def.entity !== "LEAD") throw new Error();
    expect(compileLeadSegment(def, ctx)).toEqual({
      AND: [
        { phone: { not: null } },
        { OR: [{ status: { in: ["OPEN"] } }, { sourceId: { in: [id] } }] },
      ],
    });
    const empty = segmentDefinitionSchema.parse({ entity: "MEMBER" });
    if (empty.entity !== "MEMBER") throw new Error();
    expect(compileMemberSegment(empty, ctx)).toEqual({
      status: { not: "ARCHIVED" },
      anonymizedAt: null,
      phone: { not: null },
    });
  });

  it("rejects unknown fields, operators, raw values and injection attempts", () => {
    const bad = [
      {
        entity: "MEMBER",
        conditions: [{ field: "email", op: "in", value: ["x"] }],
      },
      {
        entity: "MEMBER",
        conditions: [{ field: "status", op: "raw", value: "1=1" }],
      },
      {
        entity: "MEMBER",
        conditions: [
          {
            field: "status",
            op: "in",
            value: ["ACTIVE'; DROP TABLE member_profile;--"],
          },
        ],
      },
      {
        entity: "MEMBER",
        conditions: [
          {
            field: "branch",
            op: "in",
            value: ["' OR tenant_id IS NOT NULL --"],
          },
        ],
      },
      {
        entity: "MEMBER",
        conditions: [{ field: "lastVisitDaysAgo", op: "gte", value: "14" }],
      },
      {
        entity: "MEMBER",
        conditions: [
          { field: "expiresInDays", op: "between", value: { min: 9, max: 1 } },
        ],
      },
      {
        entity: "LEAD",
        conditions: [{ field: "tags", op: "hasAny", value: ["x"] }],
      },
      { entity: "TENANT", conditions: [] },
      {
        entity: "MEMBER",
        conditions: [{ field: "status", op: "in", value: ["ARCHIVED"] }],
      },
    ];
    for (const d of bad)
      expect(
        segmentDefinitionSchema.safeParse(d).success,
        JSON.stringify(d),
      ).toBe(false);
  });

  it("describes itself in plain language", () => {
    const def = segmentDefinitionSchema.parse({
      entity: "MEMBER",
      conditions: [
        { field: "membership", op: "is", value: "LAPSED" },
        { field: "expiredDaysAgo", op: "between", value: { min: 30, max: 60 } },
      ],
    });
    expect(describeSegment(def)).toBe(
      "membership lapsed and membership ended 30–60 days ago",
    );
  });
});
