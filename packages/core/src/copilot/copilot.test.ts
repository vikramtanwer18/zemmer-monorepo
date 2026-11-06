import { describe, expect, it } from "vitest";
import { numbersIn, ungroundedNumbers } from "./grounding";
import { routeQuestion } from "./router";
import { TOOLS, toolByName } from "./tools";

describe("number grounding", () => {
  const results = [
    {
      summary: "3 memberships end in the next 7 days",
      data: {
        collectedMinor: 1234550,
        renewal: 0.4567,
        figures: [{ value: 182, display: "₹12,345.50" }],
        minutes: 150,
      },
    },
  ];
  it("ignores dates, times, codes and small structural numbers", () => {
    expect(
      numbersIn(
        "On 2026-11-06 at 10:30 am, 6 Nov 2026, invoice INV-0042 for M00017: 182 members",
      ),
    ).toEqual(["182"]);
    expect(ungroundedNumbers("Top 5 in the last 7 days", results)).toEqual([]);
  });
  it("accepts numbers from tool results in the forms a writer uses", () => {
    expect(
      ungroundedNumbers(
        "Collected ₹12,345.50 (about ₹12,346); renewal 45.7% (45.67%); 182 active; 3 expiring; 2.5 hours",
        results,
      ),
    ).toEqual([]);
  });
  it("flags numbers that no tool returned", () => {
    expect(
      ungroundedNumbers(
        "Revenue grew 23% to ₹15,000 with 190 members",
        results,
      ),
    ).toEqual(["23", "15,000", "190"]);
  });
  it("numbers in the user's question are allowed", () => {
    expect(
      ungroundedNumbers(
        "Here are members expiring in 45 days",
        results,
        "who expires in the next 45 days?",
      ),
    ).toEqual([]);
  });
});

describe("keyword routing (fallback mode and the fake provider)", () => {
  const first = (q: string) => routeQuestion(q)[0]!;
  it("maps the spec's example questions to tools", () => {
    expect(first("Which memberships expire this week?")).toEqual({
      name: "list_expiring_memberships",
      args: { days: 7 },
    });
    expect(first("Which members have a renewal coming up?").name).toBe(
      "list_expiring_memberships",
    );
    expect(first("Which leads require follow-up today?").name).toBe(
      "list_leads_needing_followup",
    );
    expect(
      first("Which campaigns produced the most paid memberships?"),
    ).toEqual({ name: "campaign_performance", args: { preset: "this_month" } });
    expect(first("Which branches have declining attendance?").name).toBe(
      "branch_attendance_trend",
    );
    expect(first("What payments require reconciliation?").name).toBe(
      "list_unreconciled_payments",
    );
    expect(first("Summarize this week's business performance")).toEqual({
      name: "weekly_summary",
      args: { week: "this_week" },
    });
    expect(first("Why did membership revenue change this month?").name).toBe(
      "compare_periods",
    );
    expect(first("How is the renewal rate calculated?")).toEqual({
      name: "explain_metric",
      args: { key: "memberships.renewal_rate" },
    });
    expect(first("Who has overdue dues?").name).toBe("list_overdue_invoices");
    expect(first("hello").name).toBe("get_kpis");
  });
});

describe("tool argument schemas", () => {
  it("every tool has a JSON schema the provider can read", async () => {
    const { toolDefinitions } = await import("./tools");
    const owner = {
      grants: [
        {
          roleKey: "GYM_OWNER",
          branchId: null,
          permissions: new Set([
            "reports.view",
            "reports.financial",
            "memberships.view",
            "leads.view",
            "billing.view",
            "tasks.manage",
          ] as const),
        },
      ],
    };
    const defs = toolDefinitions(owner as never);
    expect(defs.map((d) => d.name).sort()).toEqual(
      TOOLS.map((t) => t.name).sort(),
    );
    for (const d of defs)
      expect(d.parameters).toMatchObject({ type: "object" });
    // A trainer without report access gets no data tools at all.
    expect(
      toolDefinitions({
        grants: [
          {
            roleKey: "TRAINER",
            branchId: null,
            permissions: new Set(["fitness.manage"]),
          },
        ],
      } as never),
    ).toEqual([]);
  });
  it("drops model-supplied tenant ids and rejects bad values", () => {
    const t = toolByName("list_expiring_memberships")!;
    const ok = t.schema.safeParse({
      days: 7,
      tenantId: "00000000-0000-4000-8000-000000000000",
      tenant_id: "x",
    });
    expect(ok.success && ok.data).toEqual({ days: 7 });
    expect(t.schema.safeParse({ days: 0 }).success).toBe(false);
    expect(t.schema.safeParse({ days: "7; DROP TABLE" }).success).toBe(false);
    expect(
      toolByName("get_kpis")!.schema.safeParse({ keys: ["not.a.kpi"] }).success,
    ).toBe(false);
    expect(
      toolByName("get_kpis")!.schema.safeParse({ preset: "forever" }).success,
    ).toBe(false);
    expect(
      toolByName("propose_follow_up_task")!.schema.safeParse({
        title: "Call",
        leadId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
