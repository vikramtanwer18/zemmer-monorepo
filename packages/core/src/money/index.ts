/**
 * Money is always an integer number of minor units (paise for INR) plus an ISO 4217 code.
 * Never use floats for amounts. Rounding is half-up (half away from zero), done with BigInt.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

const BPS_SCALE = 10_000n;

export function money(amountMinor: number, currency = "INR"): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(
      `amountMinor must be a safe integer, got ${amountMinor}`,
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RangeError(
      `currency must be an ISO 4217 code, got "${currency}"`,
    );
  }
  return Object.freeze({ amountMinor, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

function fromBigInt(value: bigint, currency: string): Money {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError("Amount exceeds the safe integer range");
  }
  return money(Number(value), currency);
}

/** Integer division rounding half away from zero. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return fromBigInt(BigInt(a.amountMinor) + BigInt(b.amountMinor), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return fromBigInt(BigInt(a.amountMinor) - BigInt(b.amountMinor), a.currency);
}

function assertBasisPoints(basisPoints: number): void {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(
      `basisPoints must be a non-negative integer, got ${basisPoints}`,
    );
  }
}

/** `basisPoints` of `amount`: 18% GST = 1800. */
export function percentOf(amount: Money, basisPoints: number): Money {
  assertBasisPoints(basisPoints);
  return fromBigInt(
    divideHalfUp(BigInt(amount.amountMinor) * BigInt(basisPoints), BPS_SCALE),
    amount.currency,
  );
}

/** Splits a tax-inclusive price into net + tax. `net + tax === gross` always. */
export function splitInclusive(
  gross: Money,
  basisPoints: number,
): { net: Money; tax: Money } {
  assertBasisPoints(basisPoints);
  const net = divideHalfUp(
    BigInt(gross.amountMinor) * BPS_SCALE,
    BPS_SCALE + BigInt(basisPoints),
  );
  return {
    net: fromBigInt(net, gross.currency),
    tax: fromBigInt(BigInt(gross.amountMinor) - net, gross.currency),
  };
}

/** Formats for display, e.g. ₹1,00,000.00 for en-IN. */
export function formatMoney(value: Money, locale = "en-IN"): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const sign = value.amountMinor < 0 ? "-" : "";
  const abs = String(Math.abs(value.amountMinor)).padStart(digits + 1, "0");
  const decimal =
    digits === 0
      ? abs
      : `${abs.slice(0, abs.length - digits)}.${abs.slice(abs.length - digits)}`;
  // Intl accepts a decimal string, which keeps the value exact (no float division).
  // (The ES2022 lib typings only declare number | bigint, hence the cast.)
  return formatter.format(`${sign}${decimal}` as unknown as number);
}

/**
 * Parses an amount typed in rupees ("1,180", "1180.5", "₹ 99.99") into paise, without floats.
 * Returns null for anything else (more than 2 decimals, negative, letters).
 */
export function parseMajorToMinor(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "").replace(/^INR/i, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Paise → "1180.50" for form fields (no currency symbol, no grouping). */
export function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
