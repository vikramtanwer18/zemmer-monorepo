import { divideHalfUp } from "../money";

/**
 * GST tax engine (D-11). Pure; every rule here is unit-tested.
 *
 * - Amounts are integer paise. Rounding is half-up to the paisa, per line.
 * - Discounts (coupons) apply to the price before tax.
 * - INTRA supply (supplier state = place of supply): CGST + SGST at half the rate each.
 *   INTER supply: IGST at the full rate. NONE: unregistered supplier, no tax lines.
 * - Exclusive prices: taxable = price − discount; each tax = round(taxable × rate).
 * - Inclusive prices: taxable = round(gross × 1 / (1 + rate)); for INTRA, CGST = round(taxable ×
 *   rate/2) and SGST takes the remainder, so the line total always equals the gross price.
 */
export type SupplyType = "INTRA" | "INTER" | "NONE";

export type TaxLineInput = {
  /** Unit price as configured (inclusive or exclusive per the invoice). */
  unitPriceMinor: number;
  quantity?: number;
  discountMinor?: number;
  rateBps: number;
};

export type TaxLineResult = {
  grossMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxRateBps: number;
  cgstRateBps: number;
  sgstRateBps: number;
  igstRateBps: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
};

const BPS = 10_000n;

function n(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Amount too large");
  return Number(value);
}

export function supplyType(input: {
  gstRegistered: boolean;
  supplierStateCode: string | null;
  placeOfSupply: string | null;
}): SupplyType {
  if (!input.gstRegistered) return "NONE";
  if (!input.supplierStateCode || !input.placeOfSupply) return "INTRA";
  return input.supplierStateCode === input.placeOfSupply ? "INTRA" : "INTER";
}

export function computeTaxLine(
  line: TaxLineInput,
  supply: SupplyType,
  pricesIncludeTax: boolean,
): TaxLineResult {
  const quantity = line.quantity ?? 1;
  for (const [name, v] of [
    ["unitPriceMinor", line.unitPriceMinor],
    ["discountMinor", line.discountMinor ?? 0],
    ["rateBps", line.rateBps],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new RangeError("quantity must be ≥ 1");

  const gross = BigInt(line.unitPriceMinor) * BigInt(quantity);
  const discount = BigInt(Math.min(line.discountMinor ?? 0, Number(gross)));
  const net = gross - discount;
  const rate = supply === "NONE" ? 0n : BigInt(line.rateBps);
  const half = rate / 2n;

  let taxable: bigint;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  if (rate === 0n) {
    taxable = net;
  } else if (pricesIncludeTax) {
    taxable = divideHalfUp(net * BPS, BPS + rate);
    const tax = net - taxable;
    if (supply === "INTRA") {
      cgst = divideHalfUp(taxable * half, BPS);
      sgst = tax - cgst;
    } else {
      igst = tax;
    }
  } else {
    taxable = net;
    if (supply === "INTRA") {
      cgst = divideHalfUp(taxable * half, BPS);
      sgst = divideHalfUp(taxable * (rate - half), BPS);
    } else {
      igst = divideHalfUp(taxable * rate, BPS);
    }
  }

  return {
    grossMinor: n(gross),
    discountMinor: n(discount),
    taxableMinor: n(taxable),
    taxRateBps: Number(rate),
    cgstRateBps: supply === "INTRA" ? Number(half) : 0,
    sgstRateBps: supply === "INTRA" ? Number(rate - half) : 0,
    igstRateBps: supply === "INTER" ? Number(rate) : 0,
    cgstMinor: n(cgst),
    sgstMinor: n(sgst),
    igstMinor: n(igst),
    totalMinor: n(taxable + cgst + sgst + igst),
  };
}

export type InvoiceTotals = {
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
};

export function sumTotals(lines: TaxLineResult[]): InvoiceTotals {
  return lines.reduce<InvoiceTotals>(
    (acc, l) => ({
      taxableMinor: acc.taxableMinor + l.taxableMinor,
      cgstMinor: acc.cgstMinor + l.cgstMinor,
      sgstMinor: acc.sgstMinor + l.sgstMinor,
      igstMinor: acc.igstMinor + l.igstMinor,
      totalMinor: acc.totalMinor + l.totalMinor,
    }),
    {
      taxableMinor: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      totalMinor: 0,
    },
  );
}

/**
 * Splits a credit amount (incl. tax) back into taxable + tax in the same proportion as the
 * invoice, for credit notes. The parts always add up to `amountMinor`.
 */
export function proportionalTaxSplit(
  amountMinor: number,
  invoice: InvoiceTotals,
): InvoiceTotals {
  if (invoice.totalMinor === 0 || amountMinor === 0) {
    return {
      taxableMinor: amountMinor,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      totalMinor: amountMinor,
    };
  }
  const amount = BigInt(amountMinor);
  const total = BigInt(invoice.totalMinor);
  const cgst = divideHalfUp(amount * BigInt(invoice.cgstMinor), total);
  const sgst = divideHalfUp(amount * BigInt(invoice.sgstMinor), total);
  const igst = divideHalfUp(amount * BigInt(invoice.igstMinor), total);
  return {
    taxableMinor: n(amount - cgst - sgst - igst),
    cgstMinor: n(cgst),
    sgstMinor: n(sgst),
    igstMinor: n(igst),
    totalMinor: amountMinor,
  };
}
