import { z } from "zod";

/**
 * Pure fitness rules (M7): program structure, which day is next, personal records, assessment
 * metrics. General fitness tracking only: no diagnoses, no medical advice.
 */

export const NON_MEDICAL_DISCLAIMER =
  "General fitness guidance, not medical advice. Check with a doctor before starting if you have a health condition, injury or are pregnant.";

const itemSchema = z
  .object({
    /** Stable within the plan; sets are logged against it. */
    id: z.string().regex(/^[a-z0-9]{6,24}$/),
    exerciseId: z.uuid(),
    sets: z.number().int().min(1).max(20),
    repsMin: z.number().int().min(1).max(100).optional(),
    repsMax: z.number().int().min(1).max(100).optional(),
    durationSec: z.number().int().min(5).max(7200).optional(),
    distanceM: z.number().int().min(10).max(100_000).optional(),
    weightGuidance: z.string().trim().max(80).optional(),
    restSec: z.number().int().min(0).max(600).default(60),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((i) => !i.repsMin || !i.repsMax || i.repsMin <= i.repsMax, {
    message: "Reps: min above max.",
    path: ["repsMax"],
  });

const daySchema = z.object({
  title: z.string().trim().min(1).max(60),
  items: z.array(itemSchema).min(1, "Add at least one exercise.").max(20),
});

export const workoutStructureSchema = z
  .object({
    weeks: z
      .array(z.object({ days: z.array(daySchema).min(1).max(7) }))
      .min(1)
      .max(16),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.weeks.forEach((w, wi) =>
      w.days.forEach((d, di) =>
        d.items.forEach((it, ii) => {
          if (ids.has(it.id))
            ctx.addIssue({
              code: "custom",
              path: ["weeks", wi, "days", di, "items", ii, "id"],
              message: "Duplicate item id.",
            });
          ids.add(it.id);
        }),
      ),
    );
  });

export type WorkoutStructure = z.infer<typeof workoutStructureSchema>;
export type WorkoutDay = WorkoutStructure["weeks"][number]["days"][number];
export type WorkoutItem = WorkoutDay["items"][number];

export const dayKey = (week: number, day: number) => `w${week}d${day}`;

export function dayByKey(
  s: WorkoutStructure,
  key: string,
): (WorkoutDay & { week: number; day: number }) | null {
  const m = /^w(\d+)d(\d+)$/.exec(key);
  if (!m) return null;
  const week = Number(m[1]);
  const day = Number(m[2]);
  const d = s.weeks[week - 1]?.days[day - 1];
  return d ? { ...d, week, day } : null;
}

/**
 * The plan repeats its weeks (a 4-week plan in week 6 is on its week 2). "Today" is the first day of
 * the current plan week not completed yet this calendar week; when all are done, the week is done.
 */
export function nextPlannedDay(
  s: WorkoutStructure,
  daysSinceStart: number,
  completedThisWeek: ReadonlySet<string>,
):
  | { key: string; week: number; day: number; title: string; weekDone: false }
  | { weekDone: true; week: number } {
  const week =
    (Math.floor(Math.max(0, daysSinceStart) / 7) % s.weeks.length) + 1;
  const days = s.weeks[week - 1]!.days;
  for (let i = 0; i < days.length; i++) {
    const key = dayKey(week, i + 1);
    if (!completedThisWeek.has(key))
      return { key, week, day: i + 1, title: days[i]!.title, weekDone: false };
  }
  return { weekDone: true, week };
}

export function newItemId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

// --- personal records ------------------------------------------------------------------------------

export type SetValues = {
  reps?: number | null;
  weightKg?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
};

export type RecordKind =
  "MAX_WEIGHT" | "EST_1RM" | "MAX_REPS" | "MAX_DURATION" | "MAX_DISTANCE";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Estimated one-rep max (Epley), only from sets of 1–12 reps (beyond that the estimate is poor).
 * Shown as an estimate, never as a test result.
 */
export function estimatedOneRepMax(
  weightKg: number,
  reps: number,
): number | null {
  if (!(weightKg > 0) || reps < 1 || reps > 12) return null;
  return reps === 1 ? round2(weightKg) : round2(weightKg * (1 + reps / 30));
}

/** What this set's values are worth per record kind (only kinds that apply to the set). */
export function recordValues(
  set: SetValues,
  measure: "REPS" | "TIME" | "DISTANCE",
): Partial<Record<RecordKind, number>> {
  const out: Partial<Record<RecordKind, number>> = {};
  if (measure === "TIME") {
    if (set.durationSec && set.durationSec > 0)
      out.MAX_DURATION = set.durationSec;
    return out;
  }
  if (measure === "DISTANCE") {
    if (set.distanceM && set.distanceM > 0) out.MAX_DISTANCE = set.distanceM;
    return out;
  }
  const reps = set.reps ?? 0;
  const w = set.weightKg ?? 0;
  if (reps < 1) return out;
  if (w > 0) {
    out.MAX_WEIGHT = round2(w);
    const e = estimatedOneRepMax(w, reps);
    if (e !== null) out.EST_1RM = e;
  } else {
    out.MAX_REPS = reps;
  }
  return out;
}

/** New records: strictly better than the current best (first ever counts). */
export function detectRecords(
  set: SetValues,
  measure: "REPS" | "TIME" | "DISTANCE",
  bests: Partial<Record<RecordKind, number>>,
): { kind: RecordKind; value: number; previous: number | null }[] {
  const values = recordValues(set, measure);
  return (Object.entries(values) as [RecordKind, number][])
    .filter(([kind, v]) => bests[kind] === undefined || v > bests[kind]!)
    .map(([kind, value]) => ({ kind, value, previous: bests[kind] ?? null }));
}

// --- assessments -----------------------------------------------------------------------------------

const num = (min: number, max: number) =>
  z.coerce.number().min(min).max(max).optional();

/** Fixed metric list (units in the key). Every field optional; at least one required. */
export const assessmentMetricsSchema = z
  .object({
    weightKg: num(20, 350),
    heightCm: num(90, 250),
    bodyFatPct: num(2, 70),
    waistCm: num(30, 250),
    hipCm: num(30, 250),
    chestCm: num(30, 250),
    armCm: num(10, 80),
    thighCm: num(20, 120),
    restingHeartRate: num(30, 150),
    pushUps: num(0, 300),
    plankSec: num(0, 3600),
    sitAndReachCm: num(-40, 60),
  })
  .refine(
    (m) => Object.values(m).some((v) => v !== undefined),
    "Record at least one measurement.",
  );

export type AssessmentMetrics = z.infer<typeof assessmentMetricsSchema>;
export type MetricKey = keyof AssessmentMetrics;

export const METRIC_LABELS: Record<
  MetricKey,
  { label: string; unit: string; lowerIsBetter?: boolean }
> = {
  weightKg: { label: "Weight", unit: "kg" },
  heightCm: { label: "Height", unit: "cm" },
  bodyFatPct: { label: "Body fat", unit: "%", lowerIsBetter: true },
  waistCm: { label: "Waist", unit: "cm", lowerIsBetter: true },
  hipCm: { label: "Hip", unit: "cm" },
  chestCm: { label: "Chest", unit: "cm" },
  armCm: { label: "Arm", unit: "cm" },
  thighCm: { label: "Thigh", unit: "cm" },
  restingHeartRate: { label: "Resting heart rate", unit: "bpm" },
  pushUps: { label: "Push-ups (one go)", unit: "reps" },
  plankSec: { label: "Plank hold", unit: "s" },
  sitAndReachCm: { label: "Sit and reach", unit: "cm" },
};

/** Goal progress 0–100 from start → target with the latest value (either direction). */
export function goalProgress(
  start: number | null,
  target: number | null,
  latest: number | null,
): number | null {
  if (start === null || target === null || latest === null || start === target)
    return null;
  const p = ((latest - start) / (target - start)) * 100;
  return Math.max(0, Math.min(100, Math.round(p)));
}
