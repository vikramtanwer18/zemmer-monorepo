/**
 * Nutrition estimates (M7). Everything here is an estimate: the library value per 100 g times the
 * portion, rounded to 0.1. The source and the assumptions travel with every logged item, and the
 * member can correct the numbers.
 */

export type Per100 = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
};
export type Macros = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

/** Exact to 0.1 without float drift: work in tenths, half-up. */
function scale(per100: number, grams: number): number {
  const tenths = Math.round(per100 * 10) * Math.round(grams * 10);
  // tenths(per100) × tenths(grams) / 100 g = hundredths of a tenth → back to tenths.
  return Math.round(tenths / 1000) / 10;
}

export function estimateMacros(food: Per100, grams: number): Macros {
  if (!(grams > 0)) throw new Error("Portion must be more than 0 g");
  return {
    kcal: scale(food.kcal, grams),
    proteinG: scale(food.protein, grams),
    carbsG: scale(food.carbs, grams),
    fatG: scale(food.fat, grams),
  };
}

export function sumMacros(items: readonly Macros[]): Macros {
  const t = items.reduce(
    (a, m) => ({
      kcal: a.kcal + Math.round(m.kcal * 10),
      proteinG: a.proteinG + Math.round(m.proteinG * 10),
      carbsG: a.carbsG + Math.round(m.carbsG * 10),
      fatG: a.fatG + Math.round(m.fatG * 10),
    }),
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
  return {
    kcal: t.kcal / 10,
    proteinG: t.proteinG / 10,
    carbsG: t.carbsG / 10,
    fatG: t.fatG / 10,
  };
}

/** The sentence stored and shown next to an estimate. */
export function assumptionsFor(input: {
  foodName: string;
  source: string;
  grams: number;
  servings?: number | null;
  servingName?: string | null;
}): string {
  const portion =
    input.servings && input.servingName
      ? `${input.servings} × ${input.servingName} ≈ ${input.grams} g`
      : `${input.grams} g`;
  return `${input.source} values for “${input.foodName}” × ${portion}. Recipes, oil and portion sizes vary: treat as an estimate.`;
}

/** Calories implied by the macros (4/4/9); used to warn about a custom entry that doesn't add up. */
export function kcalFromMacros(m: Omit<Macros, "kcal">): number {
  return Math.round((m.proteinG * 4 + m.carbsG * 4 + m.fatG * 9) * 10) / 10;
}

export function macrosLookOff(m: Macros): boolean {
  const implied = kcalFromMacros(m);
  if (m.kcal < 30 && implied < 30) return false;
  return Math.abs(implied - m.kcal) > Math.max(25, m.kcal * 0.25);
}

export type DayTotals = Macros & { date: string; waterMl: number };
export type Targets = {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  waterMl: number | null;
};

/**
 * Weekly summary: averages over the days that have any log (an unlogged day isn't a zero day),
 * and each average as a % of the target. Labelled as estimates everywhere it's shown.
 */
export function weeklySummary(days: readonly DayTotals[], targets: Targets) {
  const logged = days.filter((d) => d.kcal > 0 || d.waterMl > 0);
  const n = logged.length;
  const avg = (f: (d: DayTotals) => number) =>
    n ? Math.round((logged.reduce((s, d) => s + f(d), 0) / n) * 10) / 10 : 0;
  const pct = (v: number, t: number | null) =>
    t ? Math.round((v / t) * 100) : null;
  const kcal = avg((d) => d.kcal);
  const protein = avg((d) => d.proteinG);
  const carbs = avg((d) => d.carbsG);
  const fat = avg((d) => d.fatG);
  const water = avg((d) => d.waterMl);
  return {
    daysLogged: n,
    average: {
      kcal,
      proteinG: protein,
      carbsG: carbs,
      fatG: fat,
      waterMl: Math.round(water),
    },
    ofTarget: {
      kcal: pct(kcal, targets.kcal),
      protein: pct(protein, targets.protein),
      carbs: pct(carbs, targets.carbs),
      fat: pct(fat, targets.fat),
      water: pct(water, targets.waterMl),
    },
  };
}
