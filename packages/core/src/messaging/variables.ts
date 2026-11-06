import { z } from "zod";

/**
 * Where a template placeholder's value comes from (campaign variable mapping, automation
 * send steps). A fixed list of fields: staff pick one or type literal text, never an expression.
 */
export const VARIABLE_SOURCES = {
  first_name: "First name",
  full_name: "Full name",
  gym_name: "Gym name",
  branch_name: "Branch name",
  plan_name: "Plan name (current or last)",
  end_date: "Membership end date",
  days_left: "Days until the membership ends",
  amount_due: "Amount due",
  trial_time: "Trial date and time",
  member_code: "Member code",
} as const;

export type VariableSource = keyof typeof VARIABLE_SOURCES;
export const VARIABLE_SOURCE_KEYS = Object.keys(
  VARIABLE_SOURCES,
) as VariableSource[];

export const variableBindingSchema = z.union([
  z.object({
    source: z.enum(
      VARIABLE_SOURCE_KEYS as [VariableSource, ...VariableSource[]],
    ),
  }),
  z.object({ text: z.string().trim().min(1).max(200) }),
]);
export type VariableBinding = z.infer<typeof variableBindingSchema>;

/** placeholder ("1", "first_name") → binding. */
export const variableMapSchema = z.record(
  z.string().regex(/^[a-z0-9_]{1,40}$/i),
  variableBindingSchema,
);
export type VariableMap = z.infer<typeof variableMapSchema>;

export type SubjectFacts = Partial<Record<VariableSource, string | null>>;

/** Placeholders the map doesn't cover (all must be mapped before a launch or enable). */
export function unmappedVariables(
  variables: readonly string[],
  map: VariableMap,
): string[] {
  return variables.filter((v) => !map[v]);
}

export function resolveVariables(
  map: VariableMap,
  facts: SubjectFacts,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, binding] of Object.entries(map))
    out[key] = "text" in binding ? binding.text : (facts[binding.source] ?? "");
  return out;
}

/** A best guess for named placeholders, so most templates need no manual mapping. */
export function suggestVariableMap(variables: readonly string[]): VariableMap {
  const map: VariableMap = {};
  const aliases: Record<string, VariableSource> = {
    name: "first_name",
    first_name: "first_name",
    firstname: "first_name",
    full_name: "full_name",
    gym: "gym_name",
    gym_name: "gym_name",
    branch: "branch_name",
    plan: "plan_name",
    plan_name: "plan_name",
    end_date: "end_date",
    expiry: "end_date",
    expiry_date: "end_date",
    days: "days_left",
    days_left: "days_left",
    amount: "amount_due",
    amount_due: "amount_due",
    trial_time: "trial_time",
    member_code: "member_code",
  };
  for (const v of variables) {
    const s = aliases[v.toLowerCase()];
    if (s) map[v] = { source: s };
  }
  return map;
}
