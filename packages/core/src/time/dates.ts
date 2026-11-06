/**
 * Calendar dates ("YYYY-MM-DD") with no time or zone. Membership start/end and invoice dates are
 * local dates in the tenant timezone; they are stored in Postgres `date` columns, which Prisma
 * reads and writes as UTC-midnight Date objects.
 */
export type LocalDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: LocalDate): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Not a date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isLocalDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = parts(value);
  const check = new Date(Date.UTC(y, m - 1, d));
  return (
    check.getUTCFullYear() === y &&
    check.getUTCMonth() === m - 1 &&
    check.getUTCDate() === d
  );
}

/** For Prisma `@db.Date` columns. */
export function toDbDate(date: LocalDate): Date {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromDbDate(date: Date): LocalDate {
  return date.toISOString().slice(0, 10);
}

/** Today's date in a timezone, e.g. todayIn("Asia/Kolkata"). */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const base = toDbDate(date);
  base.setUTCDate(base.getUTCDate() + days);
  return fromDbDate(base);
}

/** Adds months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = parts(date);
  const targetMonthIndex = m - 1 + months;
  const ty = y + Math.floor(targetMonthIndex / 12);
  const tm = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromDbDate(new Date(Date.UTC(ty, tm, Math.min(d, lastDay))));
}

/** Whole days from `a` to `b` (b − a). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (toDbDate(b).getTime() - toDbDate(a).getTime()) / 86_400_000,
  );
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a > b ? a : b;
}

/**
 * The UTC instant at which a local date starts in a timezone (for period queries on timestamps:
 * periods are half-open [start, end) in the tenant timezone, KPI_DEFINITIONS.md).
 */
export function startOfDayUtc(date: LocalDate, timeZone: string): Date {
  const [y, m, d] = parts(date);
  // Start from UTC midnight and correct by the zone's offset at that moment (twice, for DST edges).
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const local = todayIn(timeZone, new Date(guess));
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(guess));
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    const localMs = toDbDate(local).getTime() + (hh * 60 + mm) * 60_000;
    guess += Date.UTC(y, m - 1, d) - localMs;
  }
  return new Date(guess);
}

// --- local wall-clock times (M3: class schedules, access hours, availability) ---------------

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const day = toDbDate(date).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Minutes after local midnight for an instant, in a timezone (0 … 1439). */
export function localMinuteOf(instant: Date, timeZone: string): number {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return hh * 60 + mm;
}

/** The UTC instant of a local date + minutes after midnight in a timezone. */
export function localTimeToUtc(
  date: LocalDate,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const target = toDbDate(date).getTime() + minuteOfDay * 60_000;
  let guess = target;
  // Correct by the zone offset at the guessed instant (twice, for DST edges).
  for (let i = 0; i < 2; i++) {
    const instant = new Date(guess);
    const localMs =
      toDbDate(todayIn(timeZone, instant)).getTime() +
      localMinuteOf(instant, timeZone) * 60_000;
    guess += target - localMs;
  }
  return new Date(guess);
}

/** A `datetime-local` value ("YYYY-MM-DDTHH:mm") in a timezone → the UTC instant. */
export function localDateTimeToUtc(value: string, timeZone: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new RangeError(`Not a local date-time: ${value}`);
  return localTimeToUtc(
    m[1] as LocalDate,
    Number(m[2]) * 60 + Number(m[3]),
    timeZone,
  );
}

/** The UTC instant → "YYYY-MM-DDTHH:mm" in a timezone (for `datetime-local` inputs). */
export function utcToLocalDateTime(instant: Date, timeZone: string): string {
  return `${todayIn(timeZone, instant)}T${formatClock(localMinuteOf(instant, timeZone))}`;
}

/** "06:30" → 390. Throws RangeError on bad input. */
export function parseClock(text: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) {
    if (text.trim() === "24:00") return 1440;
    throw new RangeError(`Not a time: ${text}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 390 → "06:30". */
export function formatClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
