import { describe, expect, it } from "vitest";
import {
  allocateExplicit,
  allocateOldestFirst,
  AllocationError,
  invoiceStatusFor,
} from "./allocation";
import {
  amountInWords,
  financialYearOf,
  formatDocumentNumber,
  numberToIndianWords,
} from "./numbering";
import {
  computeTaxLine,
  proportionalTaxSplit,
  sumTotals,
  supplyType,
} from "./tax";

describe("supplyType", () => {
  it("is NONE for unregistered suppliers, INTRA in the same state, INTER across states", () => {
    expect(
      supplyType({
        gstRegistered: false,
        supplierStateCode: "08",
        placeOfSupply: "27",
      }),
    ).toBe("NONE");
    expect(
      supplyType({
        gstRegistered: true,
        supplierStateCode: "08",
        placeOfSupply: "08",
      }),
    ).toBe("INTRA");
    expect(
      supplyType({
        gstRegistered: true,
        supplierStateCode: "08",
        placeOfSupply: "27",
      }),
    ).toBe("INTER");
    // Unknown place of supply: default intra-state for services at the branch (D-11).
    expect(
      supplyType({
        gstRegistered: true,
        supplierStateCode: "08",
        placeOfSupply: null,
      }),
    ).toBe("INTRA");
  });
});

describe("computeTaxLine", () => {
  it("exclusive, intra-state, 18%: ₹1,000 + ₹90 CGST + ₹90 SGST", () => {
    expect(
      computeTaxLine(
        { unitPriceMinor: 100_000, rateBps: 1800 },
        "INTRA",
        false,
      ),
    ).toMatchObject({
      taxableMinor: 100_000,
      cgstRateBps: 900,
      sgstRateBps: 900,
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      igstMinor: 0,
      totalMinor: 118_000,
    });
  });

  it("exclusive, inter-state: IGST at the full rate", () => {
    expect(
      computeTaxLine(
        { unitPriceMinor: 100_000, rateBps: 1800 },
        "INTER",
        false,
      ),
    ).toMatchObject({
      taxableMinor: 100_000,
      igstRateBps: 1800,
      igstMinor: 18_000,
      cgstMinor: 0,
      totalMinor: 118_000,
    });
  });

  it("inclusive ₹1,180 splits back into ₹1,000 + ₹180, total unchanged", () => {
    const line = computeTaxLine(
      { unitPriceMinor: 118_000, rateBps: 1800 },
      "INTRA",
      true,
    );
    expect(line).toMatchObject({
      taxableMinor: 100_000,
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      totalMinor: 118_000,
    });
  });

  it("inclusive prices never change the total, whatever the rounding", () => {
    for (const price of [1, 99, 101, 999, 4_999, 99_999, 123_457, 2_500_001]) {
      for (const supply of ["INTRA", "INTER"] as const) {
        const line = computeTaxLine(
          { unitPriceMinor: price, rateBps: 1800 },
          supply,
          true,
        );
        expect(line.totalMinor, `${price} ${supply}`).toBe(price);
        expect(
          line.taxableMinor + line.cgstMinor + line.sgstMinor + line.igstMinor,
        ).toBe(price);
      }
    }
  });

  it("rounds half-up per line: ₹999.99 exclusive at 18%", () => {
    // 99999 × 9% = 8999.91 → 9000 each
    const line = computeTaxLine(
      { unitPriceMinor: 99_999, rateBps: 1800 },
      "INTRA",
      false,
    );
    expect(line).toMatchObject({
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      totalMinor: 117_999,
    });
  });

  it("odd rates split CGST/SGST so they add up to the full rate", () => {
    const line = computeTaxLine(
      { unitPriceMinor: 10_000, rateBps: 500 },
      "INTRA",
      false,
    );
    expect(line.cgstRateBps + line.sgstRateBps).toBe(500);
    expect(line.cgstMinor + line.sgstMinor).toBe(500);
  });

  it("unregistered suppliers charge no tax and the total is the net price", () => {
    expect(
      computeTaxLine(
        { unitPriceMinor: 150_000, rateBps: 1800, discountMinor: 10_000 },
        "NONE",
        false,
      ),
    ).toMatchObject({
      taxableMinor: 140_000,
      taxRateBps: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      totalMinor: 140_000,
    });
  });

  it("applies the coupon before tax (exclusive)", () => {
    const line = computeTaxLine(
      { unitPriceMinor: 100_000, rateBps: 1800, discountMinor: 20_000 },
      "INTRA",
      false,
    );
    expect(line).toMatchObject({
      discountMinor: 20_000,
      taxableMinor: 80_000,
      cgstMinor: 7_200,
      totalMinor: 94_400,
    });
  });

  it("applies the coupon before tax (inclusive)", () => {
    const line = computeTaxLine(
      { unitPriceMinor: 118_000, rateBps: 1800, discountMinor: 11_800 },
      "INTRA",
      true,
    );
    expect(line).toMatchObject({ taxableMinor: 90_000, totalMinor: 106_200 });
  });

  it("caps the discount at the price", () => {
    expect(
      computeTaxLine(
        { unitPriceMinor: 5_000, rateBps: 1800, discountMinor: 9_000 },
        "INTRA",
        false,
      ).totalMinor,
    ).toBe(0);
  });

  it("joining fee line + membership line sum into invoice totals", () => {
    const lines = [
      computeTaxLine(
        { unitPriceMinor: 300_000, rateBps: 1800, discountMinor: 30_000 },
        "INTRA",
        false,
      ),
      computeTaxLine({ unitPriceMinor: 50_000, rateBps: 1800 }, "INTRA", false),
    ];
    expect(sumTotals(lines)).toEqual({
      taxableMinor: 320_000,
      cgstMinor: 28_800,
      sgstMinor: 28_800,
      igstMinor: 0,
      totalMinor: 377_600,
    });
  });

  it("multiplies by quantity", () => {
    expect(
      computeTaxLine(
        { unitPriceMinor: 10_000, quantity: 3, rateBps: 0 },
        "INTRA",
        false,
      ).totalMinor,
    ).toBe(30_000);
  });

  it("rejects negative or fractional input", () => {
    expect(() =>
      computeTaxLine({ unitPriceMinor: -1, rateBps: 1800 }, "INTRA", false),
    ).toThrow();
    expect(() =>
      computeTaxLine({ unitPriceMinor: 10.5, rateBps: 1800 }, "INTRA", false),
    ).toThrow();
    expect(() =>
      computeTaxLine(
        { unitPriceMinor: 100, quantity: 0, rateBps: 1800 },
        "INTRA",
        false,
      ),
    ).toThrow();
  });
});

describe("proportionalTaxSplit (credit notes)", () => {
  it("splits a partial credit in the invoice's proportions and adds up exactly", () => {
    const invoice = {
      taxableMinor: 100_000,
      cgstMinor: 9_000,
      sgstMinor: 9_000,
      igstMinor: 0,
      totalMinor: 118_000,
    };
    const split = proportionalTaxSplit(59_000, invoice);
    expect(split).toEqual({
      taxableMinor: 50_000,
      cgstMinor: 4_500,
      sgstMinor: 4_500,
      igstMinor: 0,
      totalMinor: 59_000,
    });
    const odd = proportionalTaxSplit(33_333, invoice);
    expect(
      odd.taxableMinor + odd.cgstMinor + odd.sgstMinor + odd.igstMinor,
    ).toBe(33_333);
  });
});

describe("document numbers", () => {
  it("uses the Indian financial year and rolls over on 1 April", () => {
    expect(financialYearOf("2026-03-31")).toBe("2025-26");
    expect(financialYearOf("2026-04-01")).toBe("2026-27");
    expect(formatDocumentNumber("IT", "2025-26", 123)).toBe("IT/25-26/00123");
  });

  it("stays within 16 characters, and refuses rather than truncates", () => {
    expect(formatDocumentNumber("ABCD", "2025-26", 99_999)).toHaveLength(16);
    expect(() => formatDocumentNumber("ABCD", "2025-26", 100_000)).toThrow(
      /longer than 16/,
    );
    expect(formatDocumentNumber("AB", "2025-26", 100_000)).toBe(
      "AB/25-26/100000",
    );
  });

  it("rejects bad prefixes and sequences", () => {
    expect(() => formatDocumentNumber("it", "2025-26", 1)).toThrow();
    expect(() => formatDocumentNumber("TOOLONG", "2025-26", 1)).toThrow();
    expect(() => formatDocumentNumber("IT", "2025-26", 0)).toThrow();
  });
});

describe("amount in words", () => {
  it.each([
    [0, "Zero"],
    [15, "Fifteen"],
    [100, "One Hundred"],
    [1_180, "One Thousand One Hundred Eighty"],
    [100_000, "One Lakh"],
    [2_534_011, "Twenty Five Lakh Thirty Four Thousand Eleven"],
    [
      123_456_789,
      "Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine",
    ],
  ])("%i → %s", (value, words) => {
    expect(numberToIndianWords(value)).toBe(words);
  });

  it("writes rupees and paise", () => {
    expect(amountInWords(118_050)).toBe(
      "Rupees One Thousand One Hundred Eighty and Fifty Paise Only",
    );
    expect(amountInWords(50_000)).toBe("Rupees Five Hundred Only");
  });
});

describe("allocation", () => {
  const invoices = [
    {
      id: "b",
      issueDate: "2026-02-01",
      number: "IT/25-26/00002",
      outstandingMinor: 50_000,
    },
    {
      id: "a",
      issueDate: "2026-01-01",
      number: "IT/25-26/00001",
      outstandingMinor: 30_000,
    },
    {
      id: "c",
      issueDate: "2026-02-01",
      number: "IT/25-26/00003",
      outstandingMinor: 20_000,
    },
  ];

  it("pays the oldest invoice first, partially if needed", () => {
    expect(allocateOldestFirst(40_000, invoices)).toEqual({
      allocations: [
        { invoiceId: "a", amountMinor: 30_000 },
        { invoiceId: "b", amountMinor: 10_000 },
      ],
      creditMinor: 0,
    });
  });

  it("turns overpayment into credit", () => {
    expect(allocateOldestFirst(120_000, invoices).creditMinor).toBe(20_000);
  });

  it("with no open invoices, everything is credit", () => {
    expect(allocateOldestFirst(5_000, [])).toEqual({
      allocations: [],
      creditMinor: 5_000,
    });
  });

  it("accepts an explicit split and refuses one that over-allocates", () => {
    expect(
      allocateExplicit(60_000, invoices, [
        { invoiceId: "c", amountMinor: 20_000 },
      ]),
    ).toEqual({
      allocations: [{ invoiceId: "c", amountMinor: 20_000 }],
      creditMinor: 40_000,
    });
    expect(() =>
      allocateExplicit(60_000, invoices, [
        { invoiceId: "a", amountMinor: 30_001 },
      ]),
    ).toThrow(AllocationError);
    expect(() =>
      allocateExplicit(10_000, invoices, [
        { invoiceId: "a", amountMinor: 8_000 },
        { invoiceId: "b", amountMinor: 8_000 },
      ]),
    ).toThrow(/more than the payment/);
    expect(() =>
      allocateExplicit(10_000, invoices, [
        { invoiceId: "zzz", amountMinor: 1 },
      ]),
    ).toThrow(AllocationError);
  });

  it("derives invoice status", () => {
    expect(
      invoiceStatusFor({
        totalMinor: 100,
        allocatedMinor: 0,
        creditedMinor: 0,
        voided: false,
      }),
    ).toBe("ISSUED");
    expect(
      invoiceStatusFor({
        totalMinor: 100,
        allocatedMinor: 40,
        creditedMinor: 0,
        voided: false,
      }),
    ).toBe("PARTIALLY_PAID");
    expect(
      invoiceStatusFor({
        totalMinor: 100,
        allocatedMinor: 60,
        creditedMinor: 40,
        voided: false,
      }),
    ).toBe("PAID");
    expect(
      invoiceStatusFor({
        totalMinor: 0,
        allocatedMinor: 0,
        creditedMinor: 0,
        voided: false,
      }),
    ).toBe("PAID");
    expect(
      invoiceStatusFor({
        totalMinor: 100,
        allocatedMinor: 100,
        creditedMinor: 0,
        voided: true,
      }),
    ).toBe("VOID");
  });
});
