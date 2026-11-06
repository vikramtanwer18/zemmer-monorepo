export const INDIA_TIME_ZONE = "Asia/Kolkata";

function partsIn(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The calendar day (YYYY-MM-DD) as the gym in `timeZone` sees it. */
export function localDate(instant: Date, timeZone: string): string {
  const { year, month, day } = partsIn(instant, timeZone);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Indian financial year label, e.g. "2026-27". Flips at midnight IST on 1 April. */
export function indianFinancialYear(instant: Date): string {
  const { year, month } = partsIn(instant, INDIA_TIME_ZONE);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
