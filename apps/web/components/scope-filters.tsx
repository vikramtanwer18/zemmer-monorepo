import { PERIOD_PRESETS, PRESET_LABELS } from "@gym/core/metrics";

/**
 * Period + branch filters as a plain GET form (works without JS; the URL is shareable). A preset
 * wins unless "Custom dates" is picked. Branch-scoped staff only see their own branches.
 */
export function ScopeFilters({
  preset,
  from,
  to,
  branchId,
  branches,
  allowAll,
}: {
  preset: string | undefined;
  from: string;
  to: string;
  branchId: string | undefined;
  branches: { id: string; name: string }[];
  allowAll: boolean;
}) {
  const control =
    "h-10 rounded-md border border-border bg-surface px-2 text-sm";
  return (
    <form
      method="get"
      className="mb-6 flex flex-wrap items-end gap-2"
      aria-label="Filters"
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Period
        <select
          name="preset"
          defaultValue={preset ?? "custom"}
          className={control}
        >
          {PERIOD_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
          <option value="custom">Custom dates</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        From
        <input
          type="date"
          name="from"
          defaultValue={from}
          className={`${control} px-3`}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Until (not included)
        <input
          type="date"
          name="to"
          defaultValue={to}
          className={`${control} px-3`}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Branch
        <select
          name="branchId"
          defaultValue={branchId ?? (allowAll ? "all" : "")}
          className={control}
        >
          {allowAll ? (
            <option value="all">All branches</option>
          ) : (
            <option value="">My branches</option>
          )}
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-background"
      >
        Update
      </button>
    </form>
  );
}

/** Turns the filter query string into scope input: a preset beats dates unless "custom". */
export function scopeFromParams(
  sp: Record<string, string | string[] | undefined>,
) {
  const s = (k: string) =>
    typeof sp[k] === "string" && sp[k] !== "" ? (sp[k] as string) : undefined;
  const preset = s("preset");
  const usePreset =
    preset &&
    preset !== "custom" &&
    (PERIOD_PRESETS as readonly string[]).includes(preset);
  return {
    preset: usePreset ? preset : undefined,
    from: usePreset ? undefined : s("from"),
    to: usePreset ? undefined : s("to"),
    branchId: s("branchId"),
  };
}
