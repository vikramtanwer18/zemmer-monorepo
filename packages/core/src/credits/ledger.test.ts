import { describe, expect, it } from "vitest";
import { checkCredit, classCreditsOf, ledgerBalance } from "./ledger";

describe("credit ledger", () => {
  it("sums grants and uses; returns cancel out", () => {
    const rows = [
      { delta: 8, reason: "GRANT" },
      { delta: -1, reason: "BOOKING" },
      { delta: -1, reason: "BOOKING" },
      { delta: 1, reason: "BOOKING_RETURNED" },
    ];
    expect(ledgerBalance(rows)).toBe(7);
    expect(ledgerBalance([])).toBe(0);
  });

  it("reads the plan's class credits (null = unlimited)", () => {
    expect(classCreditsOf({ classCredits: 8 })).toBe(8);
    expect(classCreditsOf({ classCredits: 0 })).toBe(0);
    expect(classCreditsOf({ classCredits: null })).toBeNull();
    expect(classCreditsOf({})).toBeNull();
    expect(classCreditsOf(null)).toBeNull();
    expect(classCreditsOf({ classCredits: -2 })).toBeNull();
    expect(classCreditsOf({ classCredits: 1.5 })).toBeNull();
  });

  it("needs one credit per booking when the plan uses credits", () => {
    expect(checkCredit(null, 0)).toEqual({ uses: false });
    expect(checkCredit(8, 1)).toEqual({ uses: true, ok: true, after: 0 });
    expect(checkCredit(8, 0)).toEqual({ uses: true, ok: false, after: -1 });
  });
});
