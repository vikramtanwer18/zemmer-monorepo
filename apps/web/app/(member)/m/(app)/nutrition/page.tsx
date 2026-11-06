import { myEngagement } from "@gym/core/engagement";
import { myNutritionDay, searchFoods } from "@gym/core/nutrition";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  FormField,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { HealthConsentGate, TrainNav } from "@/components/member-fitness";
import { orUpgrade } from "@/components/upgrade-notice";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  correctFoodAction,
  deleteFoodAction,
  logFoodAction,
  waterAction,
} from "../workouts/actions";

export const metadata: Metadata = { title: "Food" };

const SLOTS = [
  { value: "BREAKFAST", label: "Breakfast" },
  { value: "MORNING_SNACK", label: "Morning snack" },
  { value: "LUNCH", label: "Lunch" },
  { value: "EVENING_SNACK", label: "Evening snack" },
  { value: "DINNER", label: "Dinner" },
  { value: "OTHER", label: "Other" },
];
const label = (slot: string) =>
  SLOTS.find((s) => s.value === slot)?.label ?? slot;
const r0 = (n: number) => Math.round(n);

export default async function MemberNutritionPage({
  searchParams,
}: PageProps<"/m/nutrition">) {
  const { mctx } = await requireMember("/m/nutrition");
  const sp = await searchParams;
  const { deps } = services();
  const eng = await myEngagement(deps, mctx);
  const data = eng.nutrition
    ? await orUpgrade(myNutritionDay(deps, mctx))
    : null;
  const q = typeof sp.q === "string" ? sp.q : "";
  const results = data && q ? await searchFoods(deps, mctx, q) : [];
  const editing = typeof sp.edit === "string" ? sp.edit : null;
  return (
    <>
      <h1 className="text-2xl font-semibold">Food</h1>
      <TrainNav
        current="/m/nutrition"
        nutrition={eng.nutrition}
        rewards={eng.rewards}
      />
      <Flash params={sp} />
      {!data ? (
        <EmptyState title="Food tracking isn't available at this gym" />
      ) : (
        <HealthConsentGate mctx={mctx} back="/m/nutrition">
          <Card className="flex flex-col gap-2" data-testid="day-totals">
            <CardTitle>Today (estimates)</CardTitle>
            <div className="grid grid-cols-4 gap-2 text-center text-sm">
              {[
                ["kcal", data.day.totals.kcal, data.plan?.kcalTarget],
                [
                  "protein g",
                  data.day.totals.proteinG,
                  data.plan?.proteinTarget,
                ],
                ["carbs g", data.day.totals.carbsG, data.plan?.carbsTarget],
                ["fat g", data.day.totals.fatG, data.plan?.fatTarget],
              ].map(([l, v, t]) => (
                <div key={l as string}>
                  <p className="text-lg font-semibold">{r0(v as number)}</p>
                  <p className="text-xs text-muted">
                    {l as string}
                    {t ? ` / ${t}` : ""}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">{data.note}</p>
          </Card>
          <Card className="flex flex-col gap-2">
            <CardTitle>Water</CardTitle>
            <p className="text-sm">
              {data.day.waterMl} ml
              {data.plan?.waterTargetMl
                ? ` of ${data.plan.waterTargetMl} ml`
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {[250, 500].map((ml) => (
                <form key={ml} action={waterAction}>
                  <input type="hidden" name="ml" value={ml} />
                  <Button type="submit" size="sm" variant="outline">
                    +{ml} ml
                  </Button>
                </form>
              ))}
              {data.day.waterMl > 0 && (
                <form action={waterAction}>
                  <input type="hidden" name="undo" value="1" />
                  <Button type="submit" size="sm" variant="ghost">
                    Undo
                  </Button>
                </form>
              )}
            </div>
          </Card>
          <Card className="flex flex-col gap-3">
            <CardTitle>Add food</CardTitle>
            <form method="get" className="flex gap-2">
              <input
                name="q"
                defaultValue={q}
                placeholder="Search: dal, roti, paneer…"
                aria-label="Search food"
                className="h-11 flex-1 rounded-md border border-border bg-surface px-3"
              />
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
            {results.length > 0 && (
              <ul className="flex flex-col gap-3">
                {results.slice(0, 8).map((f) => (
                  <li
                    key={f.id}
                    className="rounded-md border border-border p-2"
                  >
                    <p className="text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted">
                      {f.servingName && f.servingGrams
                        ? `${f.servingName} = ${f.servingGrams} g · `
                        : ""}
                      per 100 g: {f.kcal} kcal, P {f.protein} · C {f.carbs} · F{" "}
                      {f.fat} · {f.source}
                    </p>
                    <ActionForm
                      action={logFoodAction}
                      className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2"
                    >
                      <input type="hidden" name="foodItemId" value={f.id} />
                      <SelectField label="Meal" name="slot" options={SLOTS} />
                      {f.servingGrams ? (
                        <FormField
                          label={`How many (${f.servingName})`}
                          name="servings"
                          defaultValue="1"
                          inputMode="decimal"
                        />
                      ) : (
                        <FormField
                          label="Grams"
                          name="grams"
                          defaultValue="100"
                          inputMode="decimal"
                        />
                      )}
                      <SubmitButton size="sm">Add</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            {q && results.length === 0 && (
              <p className="text-sm text-muted">
                Not in the list. Add it with your own numbers below.
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-sm text-primary">
                Enter my own
              </summary>
              <ActionForm
                action={logFoodAction}
                resetOnSuccess
                className="mt-2 grid grid-cols-2 gap-2"
              >
                <div className="col-span-2">
                  <FormField label="What" name="name" required />
                </div>
                <SelectField label="Meal" name="slot" options={SLOTS} />
                <FormField
                  label="Calories (kcal)"
                  name="kcal"
                  inputMode="decimal"
                  required
                />
                <FormField
                  label="Protein g"
                  name="proteinG"
                  inputMode="decimal"
                />
                <FormField label="Carbs g" name="carbsG" inputMode="decimal" />
                <FormField label="Fat g" name="fatG" inputMode="decimal" />
                <FormField
                  label="Grams (optional)"
                  name="grams"
                  inputMode="decimal"
                />
                <div className="col-span-2">
                  <SubmitButton>Add</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </Card>
          <Card className="flex flex-col gap-2" data-testid="food-log">
            <CardTitle>Logged today</CardTitle>
            {data.day.items.length === 0 && (
              <p className="text-sm text-muted">Nothing yet.</p>
            )}
            <ul className="flex flex-col gap-3">
              {data.day.items.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span>
                      <span className="font-medium">{i.name}</span>{" "}
                      <span className="text-muted">· {label(i.slot)}</span>
                    </span>
                    <span className="whitespace-nowrap">
                      ~{r0(i.kcal)} kcal {i.corrected && <Badge>edited</Badge>}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    P {i.proteinG} · C {i.carbsG} · F {i.fatG} g.{" "}
                    {i.assumptions}
                  </p>
                  {editing === i.id ? (
                    <ActionForm
                      action={correctFoodAction}
                      className="mt-2 grid grid-cols-4 gap-2"
                    >
                      <input type="hidden" name="logId" value={i.id} />
                      <FormField
                        label="kcal"
                        name="kcal"
                        defaultValue={String(i.kcal)}
                        inputMode="decimal"
                      />
                      <FormField
                        label="P"
                        name="proteinG"
                        defaultValue={String(i.proteinG)}
                        inputMode="decimal"
                      />
                      <FormField
                        label="C"
                        name="carbsG"
                        defaultValue={String(i.carbsG)}
                        inputMode="decimal"
                      />
                      <FormField
                        label="F"
                        name="fatG"
                        defaultValue={String(i.fatG)}
                        inputMode="decimal"
                      />
                      <div className="col-span-4">
                        <SubmitButton size="sm">Save correction</SubmitButton>
                      </div>
                    </ActionForm>
                  ) : (
                    <div className="mt-1 flex gap-2">
                      <a
                        href={`/m/nutrition?edit=${i.id}`}
                        className="text-xs text-primary underline"
                      >
                        Correct
                      </a>
                      <form action={deleteFoodAction}>
                        <input type="hidden" name="logId" value={i.id} />
                        <button
                          type="submit"
                          className="text-xs text-muted underline"
                        >
                          Remove
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="flex flex-col gap-2" data-testid="week">
            <CardTitle>This week (estimates)</CardTitle>
            {data.week.summary.daysLogged === 0 ? (
              <p className="text-sm text-muted">
                No days logged yet this week.
              </p>
            ) : (
              <p className="text-sm">
                Average of {data.week.summary.daysLogged} logged day(s):{" "}
                {r0(data.week.summary.average.kcal)} kcal
                {data.week.summary.ofTarget.kcal !== null
                  ? ` (${data.week.summary.ofTarget.kcal}% of target)`
                  : ""}
                , protein {r0(data.week.summary.average.proteinG)} g
                {data.week.summary.ofTarget.protein !== null
                  ? ` (${data.week.summary.ofTarget.protein}%)`
                  : ""}
                , water {data.week.summary.average.waterMl} ml.
              </p>
            )}
          </Card>
          {data.plan && (
            <Card className="flex flex-col gap-2">
              <CardTitle>Your diet plan: {data.plan.name}</CardTitle>
              <ul className="text-sm">
                {data.plan.meals.map((m) => (
                  <li key={m.id}>
                    <span className="font-medium">
                      {label(m.slot)}
                      {m.time ? ` ${m.time}` : ""}:
                    </span>{" "}
                    {m.description}
                    {m.portionGrams ? ` (${m.portionGrams} g)` : ""}
                  </li>
                ))}
              </ul>
              {data.plan.notes && (
                <p className="text-sm text-muted">{data.plan.notes}</p>
              )}
              <p className="text-xs text-muted">
                General guidance from your trainer, not medical or dietetic
                advice.
              </p>
            </Card>
          )}
        </HealthConsentGate>
      )}
    </>
  );
}
