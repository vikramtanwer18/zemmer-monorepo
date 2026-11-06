import { indianFinancialYear } from "../time";
import { toDbDate, type LocalDate } from "../time/dates";

/** D-11: invoice numbers are at most 16 characters (GST rule). */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;

/** "2025-26" for any date from 1 Apr 2025 to 31 Mar 2026. */
export function financialYearOf(date: LocalDate): string {
  return indianFinancialYear(toDbDate(date));
}

/** "2025-26" → "25-26". */
export function shortFinancialYear(fy: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) throw new RangeError(`Not a financial year: ${fy}`);
  return `${m[1]!.slice(2)}-${m[2]}`;
}

export function isValidPrefix(prefix: string): boolean {
  return /^[A-Z0-9]{1,4}$/.test(prefix);
}

/**
 * PREFIX/25-26/00001. The sequence is padded to 5 digits and grows beyond that if needed; the
 * whole number must stay within 16 characters (refused rather than truncated).
 */
export function formatDocumentNumber(
  prefix: string,
  financialYear: string,
  sequence: number,
): string {
  if (!isValidPrefix(prefix))
    throw new RangeError("Prefix must be 1–4 letters or digits");
  if (!Number.isInteger(sequence) || sequence < 1)
    throw new RangeError("Sequence must be ≥ 1");
  const number = `${prefix}/${shortFinancialYear(financialYear)}/${String(sequence).padStart(5, "0")}`;
  if (number.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    throw new RangeError(
      `Document number ${number} is longer than ${MAX_DOCUMENT_NUMBER_LENGTH} characters`,
    );
  }
  return number;
}

// --- amount in words (Indian numbering) ------------------------------------------------

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(" ");
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [
    hundreds ? `${ONES[hundreds]} Hundred` : "",
    rest ? belowHundred(rest) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 123456789 → "Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine". */
export function numberToIndianWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Expected a non-negative integer");
  if (value === 0) return "Zero";
  const crore = Math.floor(value / 10_000_000);
  const lakh = Math.floor((value % 10_000_000) / 100_000);
  const thousand = Math.floor((value % 100_000) / 1000);
  const rest = value % 1000;
  return [
    crore ? `${numberToIndianWords(crore)} Crore` : "",
    lakh ? `${belowHundred(lakh)} Lakh` : "",
    thousand ? `${belowHundred(thousand)} Thousand` : "",
    rest ? belowThousand(rest) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 118050 paise → "Rupees One Thousand One Hundred Eighty and Fifty Paise Only". */
export function amountInWords(amountMinor: number, currency = "INR"): string {
  const major = Math.floor(amountMinor / 100);
  const minor = amountMinor % 100;
  const unit = currency === "INR" ? "Rupees" : currency;
  const paise = minor ? ` and ${belowHundred(minor)} Paise` : "";
  return `${unit} ${numberToIndianWords(major)}${paise} Only`;
}
