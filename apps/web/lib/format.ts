import { utcToLocalDateTime } from "@gym/core/time/dates";
import { formatMoney, money } from "@gym/core/money";

/** ₹1,180.00 from paise (bigint or number). */
export function inr(
  minor: bigint | number | null | undefined,
  currency = "INR",
): string {
  return formatMoney(money(Number(minor ?? 0), currency));
}

/** "3 Nov 2026" for a Postgres date column (UTC midnight). */
export function day(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  return d.toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "3 Nov 2026, 4:30 pm" for a timestamp, in the tenant timezone. */
export function when(value: Date | null | undefined, timeZone: string): string {
  if (!value) return "—";
  return value.toLocaleString("en-IN", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function str(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A `datetime-local` default: now + minutes, in the gym's timezone. */
export function localInputFromNow(minutes: number, timeZone: string): string {
  return utcToLocalDateTime(new Date(Date.now() + minutes * 60_000), timeZone);
}

/** A `datetime-local` default: tomorrow at a fixed time, in the gym's timezone. */
export function tomorrowAt(time: string, timeZone: string): string {
  return `${localInputFromNow(24 * 60, timeZone).slice(0, 10)}T${time}`;
}
