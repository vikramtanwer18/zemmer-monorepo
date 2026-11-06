import { describe, expect, it } from "vitest";
import { formatRupees, renderInvoicePdf, type InvoiceForPdf } from "./pdf";

const base: InvoiceForPdf = {
  number: "AL/26-27/00001",
  documentType: "TAX_INVOICE",
  issueDate: new Date("2026-11-03T00:00:00Z"),
  dueDate: new Date("2026-11-03T00:00:00Z"),
  currency: "INR",
  pricesIncludeTax: true,
  placeOfSupply: "08",
  taxableMinor: 100_000n,
  cgstMinor: 9_000n,
  sgstMinor: 9_000n,
  igstMinor: 0n,
  totalMinor: 118_000n,
  supplier: {
    legalName: "Alpha Fitness LLP",
    displayName: "Alpha",
    gstin: "08ABCDE1234F1Z5",
    stateCode: "08",
    branch: "Main",
  },
  recipient: { name: "Ravi Kumar ₹", memberCode: "M-000001" },
  lines: [
    {
      description: "Monthly membership",
      sacCode: "999723",
      quantity: 1,
      unitPriceMinor: 118_000n,
      discountMinor: 0n,
      taxableMinor: 100_000n,
      cgstRateBps: 900,
      sgstRateBps: 900,
      igstRateBps: 0,
      cgstMinor: 9_000n,
      sgstMinor: 9_000n,
      igstMinor: 0n,
      totalMinor: 118_000n,
    },
  ],
};

describe("invoice PDF", () => {
  it("renders a tax invoice and a bill (valid PDF bytes)", async () => {
    for (const documentType of ["TAX_INVOICE", "BILL"] as const) {
      const bytes = await renderInvoicePdf({ ...base, documentType });
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  it("formats rupees with Indian grouping", () => {
    expect(formatRupees(12_345_678)).toBe("Rs. 1,23,456.78");
  });
});
