import { describe, expect, it } from "vitest";
import { localTimeToUtc } from "../time/dates";
import {
  availabilityFor,
  bookingWindow,
  findConflicts,
  isLateCancel,
  occurrencesBetween,
  parseRRule,
  promotionOrder,
  toRRule,
  type AvailabilityRow,
} from "./rules";

describe("recurrence (weekly RRULE subset)", () => {
  // 2026-11-02 is a Monday.
  const monWed = { byDays: [1, 3], startDate: "2026-11-02" };

  it("materializes weekly days in a range", () => {
    expect(occurrencesBetween(monWed, "2026-11-02", "2026-11-15")).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-09",
      "2026-11-11",
    ]);
    // Range starting mid-way skips earlier dates.
    expect(occurrencesBetween(monWed, "2026-11-05", "2026-11-10")).toEqual([
      "2026-11-09",
    ]);
  });

  it("stops at UNTIL and at COUNT (counted from the start date)", () => {
    expect(
      occurrencesBetween(
        { ...monWed, untilDate: "2026-11-09" },
        "2026-11-01",
        "2026-12-31",
      ),
    ).toEqual(["2026-11-02", "2026-11-04", "2026-11-09"]);
    expect(
      occurrencesBetween({ ...monWed, count: 3 }, "2026-11-01", "2026-12-31"),
    ).toEqual(["2026-11-02", "2026-11-04", "2026-11-09"]);
    // Asking for a later window still respects the count.
    expect(
      occurrencesBetween({ ...monWed, count: 3 }, "2026-11-05", "2026-12-31"),
    ).toEqual(["2026-11-09"]);
  });

  it("round-trips RRULE text and rejects what it can't do", () => {
    const rule = toRRule({ ...monWed, untilDate: "2026-12-31" });
    expect(rule).toBe("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231");
    expect(parseRRule(`RRULE:${rule}`, "2026-11-02")).toEqual({
      byDays: [1, 3],
      startDate: "2026-11-02",
      untilDate: "2026-12-31",
      count: null,
    });
    expect(() => parseRRule("FREQ=DAILY", "2026-11-02")).toThrow(/weekly/);
    expect(() =>
      parseRRule("FREQ=WEEKLY;BYDAY=MO;INTERVAL=2", "2026-11-02"),
    ).toThrow(/Unsupported/);
    expect(() => parseRRule("FREQ=WEEKLY;BYDAY=XX", "2026-11-02")).toThrow(
      /BYDAY/,
    );
  });

  it("places sessions at the local wall-clock time", () => {
    // 06:30 IST = 01:00 UTC.
    expect(
      localTimeToUtc("2026-11-02", 390, "Asia/Kolkata").toISOString(),
    ).toBe("2026-11-02T01:00:00.000Z");
    // New York switches to EST on 1 Nov 2026: 06:30 local = 11:30 UTC after the change.
    expect(
      localTimeToUtc("2026-11-02", 390, "America/New_York").toISOString(),
    ).toBe("2026-11-02T11:30:00.000Z");
    expect(
      localTimeToUtc("2026-10-30", 390, "America/New_York").toISOString(),
    ).toBe("2026-10-30T10:30:00.000Z");
  });
});

describe("booking windows", () => {
  const s = {
    startsAt: new Date("2026-11-10T12:00:00Z"),
    bookingOpensHours: 48,
    bookingClosesMinutes: 15,
    cancelCutoffMinutes: 120,
  };
  it("opens N hours before and closes M minutes before the start", () => {
    expect(bookingWindow(s, new Date("2026-11-08T11:59:00Z"))).toBe("NOT_OPEN");
    expect(bookingWindow(s, new Date("2026-11-08T12:00:00Z"))).toBe("OPEN");
    expect(bookingWindow(s, new Date("2026-11-10T11:44:59Z"))).toBe("OPEN");
    expect(bookingWindow(s, new Date("2026-11-10T11:45:00Z"))).toBe("CLOSED");
  });
  it("treats cancellations after the cutoff as late", () => {
    expect(isLateCancel(s, new Date("2026-11-10T09:59:00Z"))).toBe(false);
    expect(isLateCancel(s, new Date("2026-11-10T10:00:00Z"))).toBe(true);
  });
});

describe("waitlist promotion order", () => {
  it("promotes the lowest waiting position first", () => {
    const order = promotionOrder([
      { id: "c", position: 3, status: "WAITING" },
      { id: "a", position: 1, status: "LEFT" },
      { id: "b", position: 2, status: "WAITING" },
      { id: "d", position: 4, status: "SKIPPED" },
    ]);
    expect(order.map((e) => e.id)).toEqual(["b", "c"]);
  });
});

describe("availability and conflicts", () => {
  const weekly = (day: number, from: number, to: number): AvailabilityRow => ({
    kind: "WEEKLY",
    dayOfWeek: day,
    date: null,
    startMinute: from,
    endMinute: to,
    available: true,
  });

  it("is unknown when nothing is set up (never blocks)", () => {
    expect(availabilityFor([], "2026-11-02", 600, 660)).toBe("UNKNOWN");
  });

  it("uses weekly hours, leave and extra hours", () => {
    const rows: AvailabilityRow[] = [
      weekly(1, 360, 720), // Monday 06:00–12:00
      {
        kind: "EXCEPTION",
        dayOfWeek: null,
        date: "2026-11-09",
        startMinute: 0,
        endMinute: 1440,
        available: false,
      },
      {
        kind: "EXCEPTION",
        dayOfWeek: null,
        date: "2026-11-07",
        startMinute: 480,
        endMinute: 600,
        available: true,
      },
    ];
    expect(availabilityFor(rows, "2026-11-02", 600, 660)).toBe("AVAILABLE");
    expect(availabilityFor(rows, "2026-11-02", 700, 760)).toBe("UNAVAILABLE");
    expect(availabilityFor(rows, "2026-11-09", 600, 660)).toBe("UNAVAILABLE"); // leave
    expect(availabilityFor(rows, "2026-11-07", 480, 540)).toBe("AVAILABLE"); // extra
    expect(availabilityFor(rows, "2026-11-03", 600, 660)).toBe("UNAVAILABLE");
  });

  it("finds trainer and room double-bookings and availability gaps", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 2, h));
    const busy = [
      {
        id: "yoga",
        kind: "CLASS" as const,
        label: "Yoga",
        startsAt: at(6),
        endsAt: at(7),
        trainerId: "t1",
        roomId: "r1",
      },
    ];
    const kinds = (c: ReturnType<typeof findConflicts>) => c.map((x) => x.kind);
    expect(
      kinds(
        findConflicts(
          { startsAt: at(6), endsAt: at(7), trainerId: "t1", roomId: "r2" },
          busy,
        ),
      ),
    ).toEqual(["TRAINER_BUSY"]);
    expect(
      kinds(
        findConflicts(
          { startsAt: at(6), endsAt: at(8), trainerId: "t2", roomId: "r1" },
          busy,
          "UNAVAILABLE",
        ),
      ),
    ).toEqual(["ROOM_BUSY", "OUTSIDE_AVAILABILITY"]);
    // Back-to-back is fine; the session itself is ignored when editing.
    expect(
      findConflicts(
        { startsAt: at(7), endsAt: at(8), trainerId: "t1", roomId: "r1" },
        busy,
      ),
    ).toEqual([]);
    expect(
      findConflicts(
        {
          id: "yoga",
          startsAt: at(6),
          endsAt: at(7),
          trainerId: "t1",
          roomId: "r1",
        },
        busy,
      ),
    ).toEqual([]);
  });
});
