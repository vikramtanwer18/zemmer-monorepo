import { describe, expect, it } from "vitest";
import {
  detectRecords,
  estimatedOneRepMax,
  goalProgress,
  nextPlannedDay,
  workoutStructureSchema,
} from "../fitness/rules";
import {
  assumptionsFor,
  estimateMacros,
  macrosLookOff,
  sumMacros,
  weeklySummary,
} from "../nutrition/rules";
import { addDays } from "../time/dates";
import {
  challengeProgress,
  computeStreak,
  newlyEarned,
  newReferralCode,
  pointsToCreditMinor,
  visitRewardAllowed,
  weekStart,
} from "./rules";

const ex = "7d4b2c1e-0b8a-4c55-9a43-2f1e5f2c9a10";

describe("personal records", () => {
  it("Epley estimate only for 1–12 reps", () => {
    expect(estimatedOneRepMax(100, 1)).toBe(100);
    expect(estimatedOneRepMax(100, 5)).toBe(116.67);
    expect(estimatedOneRepMax(100, 13)).toBeNull();
    expect(estimatedOneRepMax(0, 5)).toBeNull();
  });

  it("detects strictly better sets per kind; the first set is a record", () => {
    expect(detectRecords({ reps: 5, weightKg: 60 }, "REPS", {})).toEqual([
      { kind: "MAX_WEIGHT", value: 60, previous: null },
      { kind: "EST_1RM", value: 70, previous: null },
    ]);
    // Same weight, more reps: a better estimate but not a heavier lift.
    expect(
      detectRecords({ reps: 8, weightKg: 60 }, "REPS", {
        MAX_WEIGHT: 60,
        EST_1RM: 70,
      }),
    ).toEqual([{ kind: "EST_1RM", value: 76, previous: 70 }]);
    expect(
      detectRecords({ reps: 3, weightKg: 60 }, "REPS", {
        MAX_WEIGHT: 60,
        EST_1RM: 70,
      }),
    ).toEqual([]);
    expect(detectRecords({ reps: 20 }, "REPS", { MAX_REPS: 15 })).toEqual([
      { kind: "MAX_REPS", value: 20, previous: 15 },
    ]);
    expect(
      detectRecords({ durationSec: 90 }, "TIME", { MAX_DURATION: 90 }),
    ).toEqual([]);
    expect(detectRecords({ distanceM: 5000 }, "DISTANCE", {})).toEqual([
      { kind: "MAX_DISTANCE", value: 5000, previous: null },
    ]);
    expect(detectRecords({ reps: 0, weightKg: 80 }, "REPS", {})).toEqual([]);
  });
});

describe("workout structure", () => {
  const structure = workoutStructureSchema.parse({
    weeks: [
      {
        days: [
          {
            title: "Push",
            items: [
              {
                id: "aaaaaa",
                exerciseId: ex,
                sets: 3,
                repsMin: 8,
                repsMax: 12,
              },
            ],
          },
          { title: "Pull", items: [{ id: "bbbbbb", exerciseId: ex, sets: 3 }] },
        ],
      },
      {
        days: [
          { title: "Legs", items: [{ id: "cccccc", exerciseId: ex, sets: 4 }] },
        ],
      },
    ],
  });
  it("validates ids and ranges", () => {
    expect(
      workoutStructureSchema.safeParse({
        weeks: [
          {
            days: [
              {
                title: "x",
                items: [
                  { id: "aaaaaa", exerciseId: ex, sets: 3 },
                  { id: "aaaaaa", exerciseId: ex, sets: 3 },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workoutStructureSchema.safeParse({
        weeks: [
          {
            days: [
              {
                title: "x",
                items: [
                  {
                    id: "aaaaaa",
                    exerciseId: ex,
                    sets: 3,
                    repsMin: 12,
                    repsMax: 8,
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(structure.weeks[0]!.days[0]!.items[0]!.restSec).toBe(60);
  });
  it("picks the next day of the current plan week; weeks repeat", () => {
    expect(nextPlannedDay(structure, 0, new Set())).toMatchObject({
      key: "w1d1",
      title: "Push",
    });
    expect(nextPlannedDay(structure, 3, new Set(["w1d1"]))).toMatchObject({
      key: "w1d2",
      title: "Pull",
    });
    expect(nextPlannedDay(structure, 4, new Set(["w1d1", "w1d2"]))).toEqual({
      weekDone: true,
      week: 1,
    });
    expect(nextPlannedDay(structure, 9, new Set())).toMatchObject({
      key: "w2d1",
    });
    expect(nextPlannedDay(structure, 15, new Set())).toMatchObject({
      key: "w1d1",
    });
  });
  it("goal progress works both ways", () => {
    expect(goalProgress(80, 70, 75)).toBe(50);
    expect(goalProgress(40, 60, 70)).toBe(100);
    expect(goalProgress(80, 70, 85)).toBe(0);
    expect(goalProgress(null, 70, 75)).toBeNull();
  });
});

describe("nutrition estimates", () => {
  const dal = { kcal: 116, protein: 6.8, carbs: 18.2, fat: 2.1 };
  it("library value × portion, rounded to 0.1, no float drift", () => {
    expect(estimateMacros(dal, 150)).toEqual({
      kcal: 174,
      proteinG: 10.2,
      carbsG: 27.3,
      fatG: 3.2,
    });
    expect(
      estimateMacros({ kcal: 0.1, protein: 0.1, carbs: 0.1, fat: 0.1 }, 33.3),
    ).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
    expect(
      estimateMacros({ kcal: 333.3, protein: 10, carbs: 10, fat: 10 }, 45),
    ).toEqual({ kcal: 150, proteinG: 4.5, carbsG: 4.5, fatG: 4.5 });
    expect(() => estimateMacros(dal, 0)).toThrow();
    expect(
      sumMacros([
        { kcal: 0.1, proteinG: 0.2, carbsG: 0, fatG: 0 },
        { kcal: 0.2, proteinG: 0.1, carbsG: 0, fatG: 0 },
      ]),
    ).toEqual({ kcal: 0.3, proteinG: 0.3, carbsG: 0, fatG: 0 });
  });
  it("states its assumptions and flags custom entries that don't add up", () => {
    expect(
      assumptionsFor({
        foodName: "Dal",
        source: "IFCT 2017 (approx.)",
        grams: 150,
        servings: 1,
        servingName: "katori",
      }),
    ).toContain("1 × katori ≈ 150 g");
    expect(
      macrosLookOff({ kcal: 500, proteinG: 10, carbsG: 10, fatG: 1 }),
    ).toBe(true);
    expect(
      macrosLookOff({ kcal: 174, proteinG: 10.2, carbsG: 27.3, fatG: 3.2 }),
    ).toBe(false);
  });
  it("weekly averages only over logged days, vs targets", () => {
    const s = weeklySummary(
      [
        {
          date: "2026-11-02",
          kcal: 2000,
          proteinG: 100,
          carbsG: 250,
          fatG: 60,
          waterMl: 2500,
        },
        {
          date: "2026-11-03",
          kcal: 0,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          waterMl: 0,
        },
        {
          date: "2026-11-04",
          kcal: 1800,
          proteinG: 80,
          carbsG: 230,
          fatG: 50,
          waterMl: 1500,
        },
      ],
      { kcal: 2000, protein: 120, carbs: null, fat: 60, waterMl: 3000 },
    );
    expect(s).toEqual({
      daysLogged: 2,
      average: {
        kcal: 1900,
        proteinG: 90,
        carbsG: 240,
        fatG: 55,
        waterMl: 2000,
      },
      ofTarget: { kcal: 95, protein: 75, carbs: null, fat: 92, water: 67 },
    });
  });
});

describe("streaks (weekly, rest-aware)", () => {
  const mon = "2026-11-02"; // a Monday
  const base = {
    minVisitsPerWeek: 2,
    frozenWeeks: new Set<string>(),
    expiredOn: null,
    graceDays: 14,
    pausedToday: false,
  };
  const weeks = (n: number, perWeek: number, end = mon) => {
    const days: string[] = [];
    for (let w = 1; w <= n; w++)
      for (let d = 0; d < perWeek; d++) days.push(addDays(end, -7 * w + d));
    return days;
  };
  it("weeks with ≥ N distinct visit days count; extra visits the same day don't", () => {
    expect(weekStart("2026-11-08")).toBe(mon);
    const r = computeStreak({
      ...base,
      visitDays: [...weeks(3, 2), mon, mon, mon],
      today: addDays(mon, 2),
    });
    expect(r).toMatchObject({
      currentWeeks: 3,
      status: "ACTIVE",
      thisWeek: { visits: 1, needed: 2 },
    });
    expect(
      computeStreak({
        ...base,
        visitDays: [...weeks(3, 2), mon, addDays(mon, 1)],
        today: addDays(mon, 2),
      }).currentWeeks,
    ).toBe(4);
  });
  it("an unfinished week never breaks it; a missed full week does", () => {
    expect(
      computeStreak({ ...base, visitDays: weeks(2, 3), today: mon })
        .currentWeeks,
    ).toBe(2);
    const missed = computeStreak({
      ...base,
      visitDays: weeks(2, 3, addDays(mon, -7)),
      today: mon,
    });
    expect(missed).toMatchObject({
      currentWeeks: 0,
      longestWeeks: 2,
      status: "BROKEN",
    });
  });
  it("a paused week is skipped (frozen), not broken", () => {
    const visits = weeks(3, 2).filter(
      (d) => d >= addDays(mon, -7) || d < addDays(mon, -14),
    );
    const frozen = new Set([addDays(mon, -14)]);
    expect(
      computeStreak({
        ...base,
        visitDays: visits,
        frozenWeeks: frozen,
        today: mon,
      }).currentWeeks,
    ).toBe(2);
    expect(
      computeStreak({
        ...base,
        visitDays: weeks(2, 2),
        today: mon,
        pausedToday: true,
      }).status,
    ).toBe("FROZEN");
  });
  it("after expiry: frozen during the grace period, then reset", () => {
    const visits = weeks(4, 2);
    expect(
      computeStreak({
        ...base,
        visitDays: visits,
        today: mon,
        expiredOn: addDays(mon, -10),
      }),
    ).toMatchObject({ currentWeeks: 4, status: "FROZEN" });
    expect(
      computeStreak({
        ...base,
        visitDays: visits,
        today: mon,
        expiredOn: addDays(mon, -15),
      }),
    ).toMatchObject({ currentWeeks: 0, status: "BROKEN", longestWeeks: 4 });
  });
});

describe("rewards", () => {
  it("visit points once a day and only up to the weekly cap", () => {
    expect(
      visitRewardAllowed({
        alreadyRewardedToday: false,
        rewardedDaysThisWeek: 4,
        weeklyCap: 5,
      }),
    ).toBe(true);
    expect(
      visitRewardAllowed({
        alreadyRewardedToday: false,
        rewardedDaysThisWeek: 5,
        weeklyCap: 5,
      }),
    ).toBe(false);
    expect(
      visitRewardAllowed({
        alreadyRewardedToday: true,
        rewardedDaysThisWeek: 0,
        weeklyCap: 5,
      }),
    ).toBe(false);
  });
  it("milestones once, only when enabled", () => {
    const defs = [
      {
        key: "visits_10",
        kind: "VISITS" as const,
        threshold: 10,
        enabled: true,
      },
      {
        key: "pr_1",
        kind: "PERSONAL_RECORDS" as const,
        threshold: 1,
        enabled: false,
      },
      {
        key: "streak_4",
        kind: "STREAK_WEEKS" as const,
        threshold: 4,
        enabled: true,
      },
    ];
    const counts = {
      visits: 12,
      workouts: 0,
      personalRecords: 3,
      streakWeeks: 4,
      challenges: 0,
    };
    expect(newlyEarned(defs, counts, new Set())).toEqual([
      "visits_10",
      "streak_4",
    ]);
    expect(newlyEarned(defs, counts, new Set(["visits_10"]))).toEqual([
      "streak_4",
    ]);
  });
  it("points to credit in integer paise; codes have no look-alikes", () => {
    expect(pointsToCreditMinor(200, 50)).toBe(10_000);
    expect(() => pointsToCreditMinor(0, 50)).toThrow();
    expect(() => pointsToCreditMinor(1.5, 50)).toThrow();
    for (let i = 0; i < 50; i++)
      expect(newReferralCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
  it("challenge progress counts distinct days inside the window", () => {
    expect(
      challengeProgress(
        ["2026-11-01", "2026-11-02", "2026-11-02", "2026-11-09", "2026-11-30"],
        "2026-11-02",
        "2026-11-29",
      ),
    ).toBe(2);
  });
});
