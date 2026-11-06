import { describe, expect, it } from "vitest";
import { visitDrop } from "../retention/rules";
import {
  definitionProblems,
  evaluateConditions,
  scanTriggerKey,
  workflowDefinitionSchema,
} from "./definition";

const A = "7d4b2c1e-0b8a-4c55-9a43-2f1e5f2c9a10";
const B = "0f3b2c1e-0b8a-4c55-9a43-2f1e5f2c9a11";
const facts = {
  branchId: A,
  planId: B,
  amountMinor: 150000,
  leadSourceId: null,
  segments: new Set<string>([B]),
};

describe("workflow conditions", () => {
  it("all conditions must hold; unknown facts never match", () => {
    expect(evaluateConditions([], facts)).toBe(true);
    expect(
      evaluateConditions([{ field: "branch", op: "in", value: [A] }], facts),
    ).toBe(true);
    expect(
      evaluateConditions([{ field: "branch", op: "in", value: [B] }], facts),
    ).toBe(false);
    expect(
      evaluateConditions(
        [
          { field: "amountMinor", op: "gte", value: 100000 },
          { field: "plan", op: "in", value: [B] },
        ],
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [{ field: "amountMinor", op: "lte", value: 100000 }],
        facts,
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        [{ field: "leadSource", op: "in", value: [A] }],
        facts,
      ),
    ).toBe(false);
    expect(
      evaluateConditions([{ field: "segment", op: "in", value: B }], facts),
    ).toBe(true);
    expect(
      evaluateConditions([{ field: "amountMinor", op: "gte", value: 0 }], {
        ...facts,
        amountMinor: null,
      }),
    ).toBe(false);
  });
});

describe("workflow definitions", () => {
  it("validates steps and refuses unknown step types or code", () => {
    const ok = workflowDefinitionSchema.safeParse({
      trigger: { type: "membership.expiring", days: 7 },
      steps: [
        { type: "wait", hours: 24 },
        { type: "owner_alert", message: "Renewal due" },
      ],
      exitWhen: ["RENEWED"],
    });
    expect(ok.success).toBe(true);
    for (const steps of [
      [{ type: "run_code", code: "process.exit()" }],
      [{ type: "wait", hours: 0 }],
      [
        { type: "owner_alert", message: "x" },
        { type: "wait", hours: 2 },
      ],
      [],
      [{ type: "create_task", title: "Call", assignTo: "USER" }],
    ])
      expect(
        workflowDefinitionSchema.safeParse({
          trigger: { type: "lead.created" },
          steps,
        }).success,
        JSON.stringify(steps),
      ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        trigger: { type: "payment.overdue" },
        steps: [{ type: "owner_alert", message: "x" }],
      }).success,
    ).toBe(false);
  });

  it("flags steps that don't fit the trigger's subject", () => {
    const d = workflowDefinitionSchema.parse({
      trigger: { type: "membership.expired", days: 30 },
      steps: [{ type: "update_lead_stage", stageId: A }],
      exitWhen: [],
    });
    expect(definitionProblems(d)).toHaveLength(1);
    expect(scanTriggerKey("membership.expiring", A, 7)).toBe(
      `membership.expiring:${A}:7`,
    );
  });
});

describe("visit drop", () => {
  it("compares 14 days with half of the 28 before, needs a baseline", () => {
    expect(visitDrop(2, 3)).toBeNull();
    expect(visitDrop(2, 8)).toEqual({ dropPercent: 50, expected: 4 });
    expect(visitDrop(6, 8)).toEqual({ dropPercent: 0, expected: 4 });
  });
});
