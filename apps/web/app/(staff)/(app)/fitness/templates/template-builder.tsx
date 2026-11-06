"use client";

import {
  ActionForm,
  Button,
  FormField,
  SelectField,
  SubmitButton,
  type FormAction,
} from "@gym/ui";
import { useMemo, useState } from "react";

type Ex = {
  id: string;
  name: string;
  measure: "REPS" | "TIME" | "DISTANCE";
  primaryMuscle: string;
};
type Item = {
  id: string;
  exerciseId: string;
  sets: number;
  repsMin?: number;
  repsMax?: number;
  durationSec?: number;
  distanceM?: number;
  weightGuidance?: string;
  restSec: number;
  notes?: string;
};
type Day = { title: string; items: Item[] };
export type Structure = { weeks: { days: Day[] }[] };

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
const input =
  "h-10 w-full rounded-md border border-border bg-surface px-2 text-sm";

/**
 * Weeks → days → exercises. Saved as JSON and validated on the server (sets, reps, rest ranges;
 * exercises must be in this gym's library). Works on a phone: one column, big targets.
 */
export function TemplateBuilder({
  action,
  exercises,
  initial,
  templateId,
  name,
  description,
  level,
  extraHidden,
  submitLabel = "Save template",
  hideMeta,
}: {
  action: FormAction;
  exercises: Ex[];
  initial: Structure | null;
  templateId?: string;
  name?: string;
  description?: string | null;
  level?: string;
  extraHidden?: Record<string, string>;
  submitLabel?: string;
  hideMeta?: boolean;
}) {
  const [s, setS] = useState<Structure>(
    initial ?? { weeks: [{ days: [{ title: "Day 1", items: [] }] }] },
  );
  const [filter, setFilter] = useState("");
  const byId = useMemo(
    () => new Map(exercises.map((e) => [e.id, e])),
    [exercises],
  );
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f
      ? exercises.filter(
          (e) =>
            e.name.toLowerCase().includes(f) || e.primaryMuscle.includes(f),
        )
      : exercises;
  }, [exercises, filter]);
  const groups = useMemo(() => {
    const g = new Map<string, Ex[]>();
    for (const e of shown)
      g.set(e.primaryMuscle, [...(g.get(e.primaryMuscle) ?? []), e]);
    return [...g.entries()];
  }, [shown]);

  const update = (fn: (draft: Structure) => void) =>
    setS((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  return (
    <ActionForm action={action} className="flex flex-col gap-4">
      {templateId && (
        <input type="hidden" name="templateId" value={templateId} />
      )}
      {Object.entries(extraHidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="structure" value={JSON.stringify(s)} />
      {!hideMeta && (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Name" name="name" defaultValue={name} required />
          <SelectField
            label="Level"
            name="level"
            defaultValue={level ?? "BEGINNER"}
            options={[
              { value: "BEGINNER", label: "Beginner" },
              { value: "INTERMEDIATE", label: "Intermediate" },
              { value: "ADVANCED", label: "Advanced" },
            ]}
          />
          <FormField
            label="Description"
            name="description"
            defaultValue={description ?? ""}
          />
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm font-medium">
        Find an exercise (narrows the lists below)
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="squat, chest, plank…"
          className={input}
        />
      </label>
      {s.weeks.map((w, wi) => (
        <fieldset
          key={wi}
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
        >
          <legend className="px-1 text-sm font-semibold">Week {wi + 1}</legend>
          {w.days.map((d, di) => (
            <div
              key={di}
              className="flex flex-col gap-2 rounded-md bg-background p-3"
              data-testid="builder-day"
            >
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
                  Day {di + 1} title
                  <input
                    value={d.title}
                    onChange={(e) =>
                      update(
                        (x) =>
                          void (x.weeks[wi]!.days[di]!.title = e.target.value),
                      )
                    }
                    className={input}
                    aria-label={`Week ${wi + 1} day ${di + 1} title`}
                  />
                </label>
                {w.days.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update((x) => void x.weeks[wi]!.days.splice(di, 1))
                    }
                  >
                    Remove day
                  </Button>
                )}
              </div>
              {d.items.map((it, ii) => {
                const e = byId.get(it.exerciseId);
                return (
                  <div
                    key={it.id}
                    className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-2 sm:grid-cols-6"
                    data-testid="builder-item"
                  >
                    <p className="col-span-2 text-sm font-medium sm:col-span-6">
                      {ii + 1}. {e?.name ?? "Pick an exercise"}
                    </p>
                    <label className="text-xs">
                      Sets
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={it.sets}
                        onChange={(ev) =>
                          update(
                            (x) =>
                              void (x.weeks[wi]!.days[di]!.items[ii]!.sets =
                                Number(ev.target.value) || 1),
                          )
                        }
                        className={input}
                        aria-label={`${e?.name} sets`}
                      />
                    </label>
                    {e?.measure === "TIME" ? (
                      <label className="text-xs">
                        Seconds
                        <input
                          type="number"
                          min={5}
                          value={it.durationSec ?? ""}
                          onChange={(ev) =>
                            update(
                              (x) =>
                                void (x.weeks[wi]!.days[di]!.items[
                                  ii
                                ]!.durationSec = num(ev.target.value)),
                            )
                          }
                          className={input}
                          aria-label={`${e?.name} seconds`}
                        />
                      </label>
                    ) : e?.measure === "DISTANCE" ? (
                      <label className="text-xs">
                        Metres
                        <input
                          type="number"
                          min={10}
                          value={it.distanceM ?? ""}
                          onChange={(ev) =>
                            update(
                              (x) =>
                                void (x.weeks[wi]!.days[di]!.items[
                                  ii
                                ]!.distanceM = num(ev.target.value)),
                            )
                          }
                          className={input}
                          aria-label={`${e?.name} metres`}
                        />
                      </label>
                    ) : (
                      <>
                        <label className="text-xs">
                          Reps from
                          <input
                            type="number"
                            min={1}
                            value={it.repsMin ?? ""}
                            onChange={(ev) =>
                              update(
                                (x) =>
                                  void (x.weeks[wi]!.days[di]!.items[
                                    ii
                                  ]!.repsMin = num(ev.target.value)),
                              )
                            }
                            className={input}
                            aria-label={`${e?.name} reps from`}
                          />
                        </label>
                        <label className="text-xs">
                          to
                          <input
                            type="number"
                            min={1}
                            value={it.repsMax ?? ""}
                            onChange={(ev) =>
                              update(
                                (x) =>
                                  void (x.weeks[wi]!.days[di]!.items[
                                    ii
                                  ]!.repsMax = num(ev.target.value)),
                              )
                            }
                            className={input}
                            aria-label={`${e?.name} reps to`}
                          />
                        </label>
                      </>
                    )}
                    <label className="text-xs">
                      Rest (s)
                      <input
                        type="number"
                        min={0}
                        max={600}
                        value={it.restSec}
                        onChange={(ev) =>
                          update(
                            (x) =>
                              void (x.weeks[wi]!.days[di]!.items[ii]!.restSec =
                                Number(ev.target.value) || 0),
                          )
                        }
                        className={input}
                        aria-label={`${e?.name} rest`}
                      />
                    </label>
                    <label className="col-span-2 text-xs">
                      Weight guidance
                      <input
                        value={it.weightGuidance ?? ""}
                        maxLength={80}
                        onChange={(ev) =>
                          update(
                            (x) =>
                              void (x.weeks[wi]!.days[di]!.items[
                                ii
                              ]!.weightGuidance = ev.target.value || undefined),
                          )
                        }
                        placeholder="e.g. a weight you can lift 10 times"
                        className={input}
                        aria-label={`${e?.name} weight guidance`}
                      />
                    </label>
                    <div className="col-span-2 flex gap-1 sm:col-span-6">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={ii === 0}
                        onClick={() =>
                          update((x) => {
                            const items = x.weeks[wi]!.days[di]!.items;
                            [items[ii - 1], items[ii]] = [
                              items[ii]!,
                              items[ii - 1]!,
                            ];
                          })
                        }
                      >
                        Up
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={ii === d.items.length - 1}
                        onClick={() =>
                          update((x) => {
                            const items = x.weeks[wi]!.days[di]!.items;
                            [items[ii + 1], items[ii]] = [
                              items[ii]!,
                              items[ii + 1]!,
                            ];
                          })
                        }
                      >
                        Down
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          update(
                            (x) =>
                              void x.weeks[wi]!.days[di]!.items.splice(ii, 1),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
              <label className="flex flex-col gap-1 text-xs font-medium">
                Add exercise
                <select
                  value=""
                  aria-label={`Add exercise to week ${wi + 1} day ${di + 1}`}
                  onChange={(ev) => {
                    const ex = byId.get(ev.target.value);
                    if (!ex) return;
                    update(
                      (x) =>
                        void x.weeks[wi]!.days[di]!.items.push({
                          id: newId(),
                          exerciseId: ex.id,
                          sets: 3,
                          restSec: ex.measure === "REPS" ? 90 : 30,
                          ...(ex.measure === "TIME"
                            ? { durationSec: 30 }
                            : ex.measure === "DISTANCE"
                              ? { distanceM: 1000 }
                              : { repsMin: 8, repsMax: 12 }),
                        }),
                    );
                  }}
                  className={input}
                >
                  <option value="">Choose…</option>
                  {groups.map(([muscle, list]) => (
                    <optgroup key={muscle} label={muscle.replace("_", " ")}>
                      {list.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {w.days.length < 7 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  update(
                    (x) =>
                      void x.weeks[wi]!.days.push({
                        title: `Day ${x.weeks[wi]!.days.length + 1}`,
                        items: [],
                      }),
                  )
                }
              >
                Add day
              </Button>
            )}
            {s.weeks.length > 1 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => update((x) => void x.weeks.splice(wi, 1))}
              >
                Remove week
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        {s.weeks.length < 16 && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              update((x) => {
                // A new week starts as a copy of the last one (fresh item ids), to tweak.
                const last = x.weeks[x.weeks.length - 1]!;
                x.weeks.push({
                  days: last.days.map((d) => ({
                    title: d.title,
                    items: d.items.map((i) => ({ ...i, id: newId() })),
                  })),
                });
              })
            }
          >
            Add week (copy of the last)
          </Button>
        )}
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
