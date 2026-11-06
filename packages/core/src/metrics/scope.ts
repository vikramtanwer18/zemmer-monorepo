import { Prisma } from "@gym/db";
import { z } from "zod";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
  type PermissionKey,
} from "../authz";
import { AppError } from "../errors";
import { nowOf, type CoreDeps } from "../tenancy/deps";
import {
  addDays,
  addMonths,
  diffDays,
  isLocalDate,
  isoWeekday,
  startOfDayUtc,
  todayIn,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import type { Period } from "./calc";

/**
 * Who a KPI is computed for. Built only on the server from the caller's AuthContext: the tenant
 * always comes from the context (never from input), and branches are narrowed to the ones the
 * caller holds the permission for.
 */
export type KpiScope = {
  tenantId: string;
  /** null = every branch (only for callers with the permission on all branches). */
  branchIds: string[] | null;
  period: Period;
  timezone: string;
  today: LocalDate;
};

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "last_90_days",
  "this_year",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  last_90_days: "Last 90 days",
  this_year: "This year",
};

/** Half-open [from, to) in the tenant's calendar. "This …" periods end tomorrow (today included). */
export function presetPeriod(preset: PeriodPreset, today: LocalDate): Period {
  const tomorrow = addDays(today, 1);
  const monday = addDays(today, 1 - isoWeekday(today));
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case "today":
      return { from: today, to: tomorrow };
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "this_week":
      return { from: monday, to: tomorrow };
    case "last_week":
      return { from: addDays(monday, -7), to: monday };
    case "last_7_days":
      return { from: addDays(today, -6), to: tomorrow };
    case "last_30_days":
      return { from: addDays(today, -29), to: tomorrow };
    case "this_month":
      return { from: monthStart, to: tomorrow };
    case "last_month":
      return { from: addMonths(monthStart, -1), to: monthStart };
    case "last_90_days":
      return { from: addDays(today, -89), to: tomorrow };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: tomorrow };
  }
}

const dateText = z.string().refine((v) => isLocalDate(v), "Pick a valid date.");

const blankToUndefined = (v: unknown) =>
  v === "" || v === null ? undefined : v;

export const MAX_PERIOD_DAYS = 731;

/** What a screen, export or Copilot tool may ask for. Tenant ids are not accepted. */
export const scopeInputSchema = z
  .object({
    preset: z.preprocess(blankToUndefined, z.enum(PERIOD_PRESETS).optional()),
    from: z.preprocess(blankToUndefined, dateText.optional()),
    to: z.preprocess(blankToUndefined, dateText.optional()),
    /** One branch, several, or "all" (owners/admins). Empty = the header's branch, else all allowed. */
    branchId: z.preprocess(
      blankToUndefined,
      z.union([z.literal("all"), z.uuid()]).optional(),
    ),
    branchIds: z.preprocess(
      blankToUndefined,
      z.array(z.uuid()).max(50).optional(),
    ),
  })
  .strip();
export type ScopeInput = z.input<typeof scopeInputSchema>;

/**
 * Resolves the period (preset, explicit dates, or `defaultPreset`) and the branches the caller
 * may see for `permission`. A branch-scoped caller asking for another branch gets FORBIDDEN;
 * asking for nothing gets their own branches.
 */
export function resolveScope(
  deps: Pick<CoreDeps, "now">,
  ctx: AuthContext,
  raw: unknown,
  permission: PermissionKey,
  defaultPreset: PeriodPreset = "this_month",
): KpiScope {
  requirePermission(ctx, permission);
  const input = parseInput(scopeInputSchema, raw ?? {});
  const today = todayIn(ctx.timezone, nowOf(deps));

  let period: Period;
  if (input.from || input.to) {
    const from = input.from ?? input.to!;
    const to = input.to ?? addDays(from, 1);
    period = { from, to };
  } else {
    period = presetPeriod(input.preset ?? defaultPreset, today);
  }
  if (period.to <= period.from)
    throw new AppError(
      "VALIDATION_FAILED",
      "The end date must be after the start date.",
    );
  if (diffDays(period.from, period.to) > MAX_PERIOD_DAYS)
    throw new AppError(
      "VALIDATION_FAILED",
      "Pick a period of two years or less.",
    );

  const allowed = allowedBranchIds(ctx, permission);
  const asked: string[] | "all" | undefined =
    input.branchIds && input.branchIds.length
      ? input.branchIds
      : input.branchId === "all"
        ? "all"
        : input.branchId
          ? [input.branchId]
          : ctx.activeBranchId
            ? [ctx.activeBranchId]
            : undefined;

  let branchIds: string[] | null;
  if (allowed === "ALL") {
    branchIds =
      asked === undefined || asked === "all" ? null : [...new Set(asked)];
  } else {
    if (asked !== undefined && asked !== "all") {
      if (asked.some((id) => !allowed.includes(id)))
        throw new AppError("FORBIDDEN", "You can't see that branch.");
      branchIds = [...new Set(asked)];
    } else {
      branchIds = allowed;
    }
    if (!branchIds.length)
      throw new AppError("FORBIDDEN", "You don't have a branch to report on.");
  }
  return {
    tenantId: ctx.tenantId,
    branchIds,
    period,
    timezone: ctx.timezone,
    today,
  };
}

/** The same scope narrowed to a permission the caller holds on fewer branches (e.g. money). */
export function narrowScope(
  ctx: AuthContext,
  scope: KpiScope,
  permission: PermissionKey,
): KpiScope | null {
  const allowed = allowedBranchIds(ctx, permission);
  if (allowed === "ALL") return scope;
  const ids = (scope.branchIds ?? allowed).filter((id) => allowed.includes(id));
  return ids.length ? { ...scope, branchIds: ids } : null;
}

export const withPeriod = (scope: KpiScope, period: Period): KpiScope => ({
  ...scope,
  period,
});

/** UTC instants for the period boundaries (tenant midnight). */
export function periodUtc(scope: Pick<KpiScope, "period" | "timezone">) {
  return {
    fromUtc: startOfDayUtc(scope.period.from, scope.timezone),
    toUtc: startOfDayUtc(scope.period.to, scope.timezone),
  };
}

/** `AND <column> = ANY(branches)`, or nothing for "every branch". */
export function branchFilter(
  column: string,
  scope: Pick<KpiScope, "branchIds">,
) {
  return scope.branchIds
    ? Prisma.sql`AND ${Prisma.raw(column)} = ANY(${scope.branchIds}::uuid[])`
    : Prisma.empty;
}
