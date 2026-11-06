import {
  addDays,
  compareDates,
  isoWeekday,
  type LocalDate,
} from "../time/dates";

// --- recurrence: a weekly RRULE subset (FREQ=WEEKLY;BYDAY=…;UNTIL=… or COUNT=…) ------------

export type Recurrence = {
  /** ISO weekdays 1 (Mon) … 7 (Sun). */
  byDays: number[];
  startDate: LocalDate;
  untilDate?: LocalDate | null;
  /** Total occurrences from startDate (inclusive). */
  count?: number | null;
};

const RRULE_DAYS = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** Every occurrence date in [from, to] (inclusive). COUNT is counted from the start date. */
export function occurrencesBetween(
  rec: Recurrence,
  from: LocalDate,
  to: LocalDate,
): LocalDate[] {
  const days = new Set(rec.byDays);
  if (days.size === 0) return [];
  const out: LocalDate[] = [];
  let seen = 0;
  let cursor = rec.startDate;
  // Bound the walk: a count can't need more than 7 × count days; an open rule stops at `to`.
  const hardEnd =
    rec.untilDate && compareDates(rec.untilDate, to) < 0 ? rec.untilDate : to;
  while (compareDates(cursor, hardEnd) <= 0) {
    if (days.has(isoWeekday(cursor))) {
      seen++;
      if (rec.count && seen > rec.count) break;
      if (compareDates(cursor, from) >= 0) out.push(cursor);
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** RRULE text for display and export, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10". */
export function toRRule(rec: Recurrence): string {
  const parts = [
    "FREQ=WEEKLY",
    `BYDAY=${[...rec.byDays]
      .sort()
      .map((d) => RRULE_DAYS[d])
      .join(",")}`,
  ];
  if (rec.untilDate) parts.push(`UNTIL=${rec.untilDate.replace(/-/g, "")}`);
  if (rec.count) parts.push(`COUNT=${rec.count}`);
  return parts.join(";");
}

/** Parses the supported subset; throws RangeError on anything else. */
export function parseRRule(text: string, startDate: LocalDate): Recurrence {
  const fields = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (!key || value === undefined)
      throw new RangeError(`Bad RRULE part: ${part}`);
    fields.set(key.toUpperCase(), value.toUpperCase());
  }
  if (fields.get("FREQ") !== "WEEKLY")
    throw new RangeError("Only weekly classes are supported (FREQ=WEEKLY).");
  for (const key of fields.keys()) {
    if (!["FREQ", "BYDAY", "UNTIL", "COUNT"].includes(key))
      throw new RangeError(`Unsupported RRULE field ${key}.`);
  }
  const byDays = (fields.get("BYDAY") ?? "").split(",").map((d) => {
    const i = RRULE_DAYS.indexOf(d as (typeof RRULE_DAYS)[number]);
    if (i < 1) throw new RangeError(`Bad BYDAY value ${d}.`);
    return i;
  });
  const until = fields.get("UNTIL");
  const count = fields.get("COUNT");
  if (until && count) throw new RangeError("Use UNTIL or COUNT, not both.");
  return {
    byDays,
    startDate,
    untilDate: until
      ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
      : null,
    count: count ? Number(count) : null,
  };
}

// --- booking windows ----------------------------------------------------------------------

export type SessionTiming = {
  startsAt: Date;
  bookingOpensHours: number;
  bookingClosesMinutes: number;
  cancelCutoffMinutes: number;
};

export type BookingWindowState = "NOT_OPEN" | "OPEN" | "CLOSED";

export function bookingWindow(s: SessionTiming, now: Date): BookingWindowState {
  const opens = s.startsAt.getTime() - s.bookingOpensHours * 3_600_000;
  const closes = s.startsAt.getTime() - s.bookingClosesMinutes * 60_000;
  if (now.getTime() < opens) return "NOT_OPEN";
  if (now.getTime() >= closes) return "CLOSED";
  return "OPEN";
}

export function bookingOpensAt(s: SessionTiming): Date {
  return new Date(s.startsAt.getTime() - s.bookingOpensHours * 3_600_000);
}

/** Free cancellation (and waitlist promotion) ends at the cutoff. */
export function cancelCutoffAt(s: SessionTiming): Date {
  return new Date(s.startsAt.getTime() - s.cancelCutoffMinutes * 60_000);
}

export function isLateCancel(s: SessionTiming, now: Date): boolean {
  return now.getTime() >= cancelCutoffAt(s).getTime();
}

/** Waiting entries in promotion order (lowest position first). */
export function promotionOrder<T extends { position: number; status: string }>(
  entries: T[],
): T[] {
  return entries
    .filter((e) => e.status === "WAITING")
    .sort((a, b) => a.position - b.position);
}

// --- availability and conflicts -------------------------------------------------------------

export type AvailabilityRow = {
  kind: "WEEKLY" | "EXCEPTION";
  dayOfWeek: number | null;
  date: LocalDate | null;
  startMinute: number;
  endMinute: number;
  available: boolean;
  branchId?: string | null;
};

/**
 * Is someone available for [startMinute, endMinute) on a local date?
 * - No rows at all: availability isn't set up, so don't block (returns "UNKNOWN").
 * - A dated "not available" exception overlapping the slot blocks it (leave).
 * - A dated "available" exception or a weekly slot must cover the whole slot.
 */
export function availabilityFor(
  rows: AvailabilityRow[],
  date: LocalDate,
  startMinute: number,
  endMinute: number,
  branchId?: string,
): "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" {
  const relevant = rows.filter(
    (r) => !branchId || !r.branchId || r.branchId === branchId,
  );
  if (relevant.length === 0) return "UNKNOWN";
  const overlaps = (r: AvailabilityRow) =>
    r.startMinute < endMinute && startMinute < r.endMinute;
  const covers = (r: AvailabilityRow) =>
    r.startMinute <= startMinute && endMinute <= r.endMinute;
  const exceptions = relevant.filter(
    (r) => r.kind === "EXCEPTION" && r.date === date,
  );
  if (exceptions.some((r) => !r.available && overlaps(r))) return "UNAVAILABLE";
  if (exceptions.some((r) => r.available && covers(r))) return "AVAILABLE";
  const weekday = isoWeekday(date);
  if (
    relevant.some(
      (r) => r.kind === "WEEKLY" && r.dayOfWeek === weekday && covers(r),
    )
  )
    return "AVAILABLE";
  return "UNAVAILABLE";
}

export type Busy = {
  id: string;
  kind: "CLASS" | "PT";
  label: string;
  startsAt: Date;
  endsAt: Date;
  trainerId: string | null;
  roomId: string | null;
};

export type Conflict = {
  kind: "TRAINER_BUSY" | "ROOM_BUSY" | "OUTSIDE_AVAILABILITY";
  message: string;
  withId?: string;
};

const intervalsOverlap = (
  a: { startsAt: Date; endsAt: Date },
  b: { startsAt: Date; endsAt: Date },
) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();

/** Trainer double-booked, room double-booked, or outside the trainer's availability. */
export function findConflicts(
  candidate: {
    id?: string;
    startsAt: Date;
    endsAt: Date;
    trainerId: string | null;
    roomId: string | null;
  },
  busy: Busy[],
  availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" = "UNKNOWN",
): Conflict[] {
  const out: Conflict[] = [];
  for (const b of busy) {
    if (candidate.id && b.id === candidate.id) continue;
    if (!intervalsOverlap(candidate, b)) continue;
    if (candidate.trainerId && b.trainerId === candidate.trainerId)
      out.push({
        kind: "TRAINER_BUSY",
        message: `The trainer is already on ${b.label} at that time.`,
        withId: b.id,
      });
    if (candidate.roomId && b.roomId === candidate.roomId)
      out.push({
        kind: "ROOM_BUSY",
        message: `The room is already used by ${b.label} at that time.`,
        withId: b.id,
      });
  }
  if (candidate.trainerId && availability === "UNAVAILABLE")
    out.push({
      kind: "OUTSIDE_AVAILABILITY",
      message:
        "That's outside the trainer's working hours (or they're on leave).",
    });
  return out;
}
