import { describe, expect, it } from "vitest";
import { indianFinancialYear, localDate } from "./index";

describe("time", () => {
  it("20:00 UTC on 31 March is already 1 April in India", () => {
    const instant = new Date("2027-03-31T20:00:00Z");
    expect(localDate(instant, "Asia/Kolkata")).toBe("2027-04-01");
    expect(localDate(instant, "UTC")).toBe("2027-03-31");
    expect(indianFinancialYear(instant)).toBe("2027-28");
  });

  it("financial year flips at midnight IST on 1 April", () => {
    expect(indianFinancialYear(new Date("2027-03-31T18:29:59Z"))).toBe(
      "2026-27",
    );
    expect(indianFinancialYear(new Date("2027-03-31T18:30:00Z"))).toBe(
      "2027-28",
    );
    expect(indianFinancialYear(new Date("2026-11-02T10:00:00Z"))).toBe(
      "2026-27",
    );
  });
});
