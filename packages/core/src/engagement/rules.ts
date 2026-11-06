import { randomInt } from "node:crypto";
import { addDays, diffDays, isoWeekday, type LocalDate } from "../time/dates";

/**
 * Engagement rules (M7, docs/KPI_DEFINITIONS.md "Streaks, milestones and rewards"). Designed not to
 * reward overtraining: visits count at most once a day, weeks count (not consecutive days), and
 * visit points stop after a weekly cap so rest days cost nothing.
 */

/** Monday of the week containing `date` (weeks run Monday–Sunday in the gym's timezone). */
export function weekStart(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}

export type StreakInput = {
  /** Local dates with at least one accepted check-in (any number per day counts once). */
  visitDays: readonly LocalDate[];
  today: LocalDate;
  minVisitsPerWeek: number;
  /** Mondays of weeks the membership was paused for 4+ days: skipped, neither counted nor broken. */
  frozenWeeks: ReadonlySet<LocalDate>;
  /** Last day of the last membership, when nothing is current (null = has a current membership). */
  expiredOn: LocalDate | null;
  graceDays: number;
  /** Membership paused today. */
  pausedToday: boolean;
};

export type StreakResult = {
  currentWeeks: number;
  longestWeeks: number;
  lastWeekStart: LocalDate | null;
  status: "ACTIVE" | "FROZEN" | "BROKEN";
  /** Days with a visit in the current week, and how many are needed. */
  thisWeek: { visits: number; needed: number };
};

/**
 * A week counts when it has ≥ N distinct visit days. The streak is the run of counting weeks up to
 * last week, plus this week once it counts (an unfinished week never breaks it). Paused weeks are
 * skipped. After a membership expires the streak is frozen for the grace period, then resets.
 */
export function computeStreak(input: StreakInput): StreakResult {
  const counts = new Map<LocalDate, number>();
  for (const d of new Set(input.visitDays))
    counts.set(weekStart(d), (counts.get(weekStart(d)) ?? 0) + 1);
  const counted = (w: LocalDate) =>
    (counts.get(w) ?? 0) >= input.minVisitsPerWeek;
  const thisWeek = weekStart(input.today);

  // Longest: walk every week from the first visit to now.
  let longest = 0;
  let run = 0;
  let lastCounted: LocalDate | null = null;
  const first = [...counts.keys()].sort()[0];
  if (first)
    for (let w = first; w <= thisWeek; w = addDays(w, 7)) {
      if (input.frozenWeeks.has(w)) continue;
      if (counted(w)) {
        run++;
        lastCounted = w;
        longest = Math.max(longest, run);
      } else if (w !== thisWeek) run = 0;
    }

  // Current: back from this week (if it counts) or last week.
  let current = 0;
  let w = counted(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  for (let guard = 0; guard < 520; guard++, w = addDays(w, -7)) {
    if (input.frozenWeeks.has(w)) continue;
    if (!counted(w)) break;
    current++;
  }

  let status: StreakResult["status"] = current > 0 ? "ACTIVE" : "BROKEN";
  if (input.pausedToday) status = "FROZEN";
  if (input.expiredOn) {
    const since = diffDays(input.expiredOn, input.today);
    if (since <= input.graceDays) status = "FROZEN";
    else {
      current = 0;
      status = "BROKEN";
    }
  }
  return {
    currentWeeks: current,
    longestWeeks: Math.max(longest, current),
    lastWeekStart: lastCounted,
    status,
    thisWeek: {
      visits: counts.get(thisWeek) ?? 0,
      needed: input.minVisitsPerWeek,
    },
  };
}

/** Visit points: once per day, and only for the first `weeklyCap` visit days of the week. */
export function visitRewardAllowed(input: {
  alreadyRewardedToday: boolean;
  rewardedDaysThisWeek: number;
  weeklyCap: number;
}): boolean {
  return (
    !input.alreadyRewardedToday && input.rewardedDaysThisWeek < input.weeklyCap
  );
}

export type AchievementDef = {
  key: string;
  kind:
    "VISITS" | "WORKOUTS" | "PERSONAL_RECORDS" | "STREAK_WEEKS" | "CHALLENGES";
  threshold: number;
  enabled: boolean;
};
export type EngagementCounts = {
  visits: number;
  workouts: number;
  personalRecords: number;
  streakWeeks: number;
  challenges: number;
};

const COUNT_OF: Record<AchievementDef["kind"], keyof EngagementCounts> = {
  VISITS: "visits",
  WORKOUTS: "workouts",
  PERSONAL_RECORDS: "personalRecords",
  STREAK_WEEKS: "streakWeeks",
  CHALLENGES: "challenges",
};

export function newlyEarned(
  defs: readonly AchievementDef[],
  counts: EngagementCounts,
  earned: ReadonlySet<string>,
): string[] {
  return defs
    .filter(
      (d) =>
        d.enabled &&
        !earned.has(d.key) &&
        counts[COUNT_OF[d.kind]] >= d.threshold,
    )
    .map((d) => d.key);
}

/** Milestones every gym starts with (editable: points, on/off). Visit days, not visits. */
export const DEFAULT_ACHIEVEMENTS: {
  key: string;
  name: string;
  description: string;
  kind: AchievementDef["kind"];
  threshold: number;
  points: number;
}[] = [
  {
    key: "visits_10",
    name: "10 visits",
    description: "Checked in on 10 different days.",
    kind: "VISITS",
    threshold: 10,
    points: 50,
  },
  {
    key: "visits_25",
    name: "25 visits",
    description: "Checked in on 25 different days.",
    kind: "VISITS",
    threshold: 25,
    points: 100,
  },
  {
    key: "visits_50",
    name: "50 visits",
    description: "Checked in on 50 different days.",
    kind: "VISITS",
    threshold: 50,
    points: 200,
  },
  {
    key: "visits_100",
    name: "100 visits",
    description: "Checked in on 100 different days.",
    kind: "VISITS",
    threshold: 100,
    points: 400,
  },
  {
    key: "workouts_1",
    name: "First workout logged",
    description: "Completed a workout in the app.",
    kind: "WORKOUTS",
    threshold: 1,
    points: 20,
  },
  {
    key: "workouts_10",
    name: "10 workouts",
    description: "Completed 10 logged workouts.",
    kind: "WORKOUTS",
    threshold: 10,
    points: 50,
  },
  {
    key: "workouts_50",
    name: "50 workouts",
    description: "Completed 50 logged workouts.",
    kind: "WORKOUTS",
    threshold: 50,
    points: 200,
  },
  {
    key: "pr_1",
    name: "First personal record",
    description: "Beat your own best on an exercise.",
    kind: "PERSONAL_RECORDS",
    threshold: 1,
    points: 20,
  },
  {
    key: "pr_10",
    name: "10 personal records",
    description: "Beat your own best 10 times.",
    kind: "PERSONAL_RECORDS",
    threshold: 10,
    points: 100,
  },
  {
    key: "streak_4",
    name: "4-week streak",
    description: "Kept your weekly streak for 4 weeks.",
    kind: "STREAK_WEEKS",
    threshold: 4,
    points: 50,
  },
  {
    key: "streak_12",
    name: "12-week streak",
    description: "Kept your weekly streak for 12 weeks.",
    kind: "STREAK_WEEKS",
    threshold: 12,
    points: 200,
  },
  {
    key: "challenge_1",
    name: "Challenge finisher",
    description: "Completed a gym challenge.",
    kind: "CHALLENGES",
    threshold: 1,
    points: 0,
  },
];

export const DEFAULT_REWARD_RULES = [
  {
    trigger: "VISIT",
    points: 10,
    label: "A visit day (once a day, up to the weekly cap)",
  },
  {
    trigger: "WORKOUT_COMPLETED",
    points: 5,
    label: "A completed workout (once a day)",
  },
  {
    trigger: "REFERRAL_CONVERTED",
    points: 500,
    label: "A friend you referred joins and pays",
  },
  {
    trigger: "CHALLENGE_COMPLETED",
    points: 0,
    label: "Completing a challenge (the challenge's own points)",
  },
  {
    trigger: "ACHIEVEMENT",
    points: 0,
    label: "Earning a milestone (the milestone's own points)",
  },
] as const;

/** Points → member credit in paise (integer; no floats for money). */
export function pointsToCreditMinor(
  points: number,
  pointValueMinor: number,
): number {
  if (!Number.isInteger(points) || points <= 0)
    throw new Error("points must be a positive integer");
  return points * pointValueMinor;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 8 characters without look-alikes (0/O, 1/I). No personal data. */
export function newReferralCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++)
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Challenge progress: distinct days in the window (a second visit or workout that day adds nothing). */
export function challengeProgress(
  days: readonly LocalDate[],
  startsOn: LocalDate,
  endsOn: LocalDate,
): number {
  return new Set(days.filter((d) => d >= startsOn && d <= endsOn)).size;
}
