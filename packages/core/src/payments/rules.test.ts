import { describe, expect, it } from "vitest";
import { allocateExplicit, allocateOldestFirst } from "../billing/allocation";
import {
  agingBucket,
  daysOverdue,
  duesReminderDue,
  dunningStage,
  linkStatusFrom,
  mergeLinkStatus,
  monthlyEquivalent,
  needsApproval,
  planRefundCreditNotes,
  saasStatusFrom,
  trialReminderDue,
  type LinkStatus,
} from "./rules";

describe("payment link state machine", () => {
  it("derives status from money received", () => {
    expect(linkStatusFrom(1000, 0, null)).toBe("CREATED");
    expect(linkStatusFrom(1000, 400, null)).toBe("PARTIALLY_PAID");
    expect(linkStatusFrom(1000, 1000, null)).toBe("PAID");
    expect(linkStatusFrom(1000, 400, "EXPIRED")).toBe("EXPIRED");
    expect(linkStatusFrom(1000, 1000, "CANCELLED")).toBe("PAID");
  });

  it("never moves backwards, whatever order events arrive in", () => {
    const orders: LinkStatus[][] = [
      ["PARTIALLY_PAID", "PAID"],
      ["PAID", "PARTIALLY_PAID"],
      ["PAID", "CREATED", "PARTIALLY_PAID"],
      ["PARTIALLY_PAID", "PAID", "PARTIALLY_PAID", "PAID"],
    ];
    for (const seq of orders)
      expect(
        seq.reduce(mergeLinkStatus, "CREATED" as LinkStatus),
        seq.join(">"),
      ).toBe("PAID");
    expect(mergeLinkStatus("PARTIALLY_PAID", "CREATED")).toBe("PARTIALLY_PAID");
    expect(mergeLinkStatus("EXPIRED", "PARTIALLY_PAID")).toBe("EXPIRED");
    // Money proves payment even on an expired link.
    expect(mergeLinkStatus("EXPIRED", "PAID")).toBe("PAID");
  });

  it("allocates a partial sequence over a link's invoices in order", () => {
    const invoices = [
      {
        id: "a",
        issueDate: "2026-11-01",
        number: "A",
        outstandingMinor: 60000,
      },
      {
        id: "b",
        issueDate: "2026-11-02",
        number: "B",
        outstandingMinor: 40000,
      },
    ];
    const first = allocateOldestFirst(70000, invoices);
    expect(first.allocations).toEqual([
      { invoiceId: "a", amountMinor: 60000 },
      { invoiceId: "b", amountMinor: 10000 },
    ]);
    const after = [{ ...invoices[1]!, outstandingMinor: 30000 }];
    const second = allocateOldestFirst(50000, after);
    expect(second.allocations).toEqual([
      { invoiceId: "b", amountMinor: 30000 },
    ]);
    expect(second.creditMinor).toBe(20000); // overpayment → member credit
    expect(() =>
      allocateExplicit(100, after, [{ invoiceId: "b", amountMinor: 200 }]),
    ).toThrow();
  });
});

describe("refund math", () => {
  it("credits the newest invoices first, capped by allocation and what can be credited", () => {
    const plan = planRefundCreditNotes(50000, [
      { invoiceId: "old", allocatedMinor: 40000, creditableMinor: 100000 },
      { invoiceId: "new", allocatedMinor: 30000, creditableMinor: 30000 },
    ]);
    expect(plan).toEqual({
      notes: [
        { invoiceId: "new", amountMinor: 30000 },
        { invoiceId: "old", amountMinor: 20000 },
      ],
      fromCreditOnlyMinor: 0,
    });
  });

  it("takes the overpayment part from credit without a credit note", () => {
    const plan = planRefundCreditNotes(120000, [
      { invoiceId: "only", allocatedMinor: 100000, creditableMinor: 100000 },
    ]);
    expect(plan).toEqual({
      notes: [{ invoiceId: "only", amountMinor: 100000 }],
      fromCreditOnlyMinor: 20000,
    });
  });

  it("asks for a second approval above the threshold only", () => {
    expect(needsApproval(500000, null)).toBe(false);
    expect(needsApproval(500000, 500000)).toBe(false);
    expect(needsApproval(500001, 500000)).toBe(true);
  });
});

describe("dues aging", () => {
  it("buckets by days past the due date", () => {
    expect(daysOverdue("2026-11-01", "2026-11-05")).toBe(4);
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(agingBucket)).toEqual([
      "current",
      "1-30",
      "1-30",
      "31-60",
      "31-60",
      "61-90",
      "61-90",
      "90+",
    ]);
  });

  it("reminds on the configured overdue days only", () => {
    expect(duesReminderDue("2026-11-01", "2026-11-02", [1, 7])).toBe(1);
    expect(duesReminderDue("2026-11-01", "2026-11-03", [1, 7])).toBeNull();
    expect(duesReminderDue("2026-11-01", "2026-11-08", [1, 7])).toBe(7);
  });
});

describe("SaaS dunning schedule", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const base = {
    current: "ACTIVE" as const,
    now,
    graceEndsAt: null,
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
  };
  it("follows ACTIVE → PAST_DUE → GRACE → SUSPENDED", () => {
    expect(saasStatusFrom({ ...base, providerStatus: "pending" })).toBe(
      "PAST_DUE",
    );
    expect(
      saasStatusFrom({
        ...base,
        providerStatus: "halted",
        graceEndsAt: new Date("2026-11-15T00:00:00Z"),
      }),
    ).toBe("GRACE");
    expect(
      saasStatusFrom({
        ...base,
        providerStatus: "halted",
        graceEndsAt: new Date("2026-11-09T00:00:00Z"),
      }),
    ).toBe("SUSPENDED");
    expect(
      saasStatusFrom({ ...base, current: "GRACE", providerStatus: "active" }),
    ).toBe("ACTIVE");
  });

  it("keeps paid-up time after a cancellation, then cancels", () => {
    expect(saasStatusFrom({ ...base, providerStatus: "cancelled" })).toBe(
      "ACTIVE",
    );
    expect(
      saasStatusFrom({
        ...base,
        providerStatus: "cancelled",
        currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
      }),
    ).toBe("CANCELLED");
    expect(
      saasStatusFrom({
        ...base,
        providerStatus: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date("2026-11-09T00:00:00Z"),
      }),
    ).toBe("CANCELLED");
  });

  it("emails once per stage", () => {
    expect(dunningStage("ACTIVE", "PAST_DUE")).toBe("PAYMENT_FAILED");
    expect(dunningStage("PAST_DUE", "GRACE")).toBe("GRACE_STARTED");
    expect(dunningStage("GRACE", "SUSPENDED")).toBe("SUSPENDED");
    expect(dunningStage("SUSPENDED", "ACTIVE")).toBe("RECOVERED");
    expect(dunningStage("ACTIVE", "ACTIVE")).toBeNull();
    expect(dunningStage("TRIALING", "ACTIVE")).toBeNull();
  });

  it("reminds 3 days and 1 day before a trial ends", () => {
    expect(trialReminderDue("2026-11-13", "2026-11-10")).toBe(3);
    expect(trialReminderDue("2026-11-11", "2026-11-10")).toBe(1);
    expect(trialReminderDue("2026-11-12", "2026-11-10")).toBeNull();
  });

  it("computes MRR per cycle", () => {
    expect(monthlyEquivalent(299900, "MONTHLY")).toBe(299900);
    expect(monthlyEquivalent(2879040, "YEARLY")).toBe(239920);
    expect(monthlyEquivalent(1619460, "HALF_YEARLY")).toBe(269910);
  });
});
