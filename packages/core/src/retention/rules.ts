/**
 * Retention rules (M6 §6, docs/KPI_DEFINITIONS.md "Retention & recovery"). Every flag records
 * which rule fired and the numbers behind it, so staff can see exactly why someone is listed.
 */

export const RETENTION_KINDS = [
  "NO_VISIT",
  "VISIT_DROP",
  "EXPIRING",
  "OVERDUE",
  "UNUSED_CREDITS",
  "TRIAL_FOLLOW_UP",
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const RETENTION_RULES: Record<
  RetentionKind,
  {
    label: string;
    unit: string;
    defaultThreshold: number;
    min: number;
    max: number;
    help: string;
    action: string;
  }
> = {
  NO_VISIT: {
    label: "No visit",
    unit: "days",
    defaultThreshold: 14,
    min: 3,
    max: 120,
    help: "Members with a current membership and no check-in for this many days.",
    action: "Call to check in, or send a we-miss-you message.",
  },
  VISIT_DROP: {
    label: "Visits dropping",
    unit: "% fewer",
    defaultThreshold: 50,
    min: 10,
    max: 100,
    help: "Visits in the last 14 days are this much lower than their usual (average of the 4 weeks before). Needs at least 4 visits in those 4 weeks.",
    action: "Ask how training is going; offer a trainer session.",
  },
  EXPIRING: {
    label: "Expiring, not renewed",
    unit: "days before end",
    defaultThreshold: 7,
    min: 1,
    max: 60,
    help: "A membership ends within this many days and nothing is lined up after it.",
    action: "Send a renewal reminder or offer.",
  },
  OVERDUE: {
    label: "Payment overdue",
    unit: "days overdue",
    defaultThreshold: 7,
    min: 1,
    max: 120,
    help: "An invoice is unpaid this many days after its due date.",
    action: "Send a payment link; call if it's large.",
  },
  UNUSED_CREDITS: {
    label: "Unused class credits",
    unit: "credits left",
    defaultThreshold: 3,
    min: 1,
    max: 100,
    help: "At least this many class credits left on a membership that ends within 14 days.",
    action: "Remind them to book classes before the credits expire.",
  },
  TRIAL_FOLLOW_UP: {
    label: "Trial not followed up",
    unit: "days after trial",
    defaultThreshold: 2,
    min: 1,
    max: 30,
    help: "A lead attended a trial this many days ago, is still open and nobody has contacted them since.",
    action: "Call to ask how the trial went and offer a plan.",
  },
};

export const UNUSED_CREDITS_WINDOW_DAYS = 14;
export const VISIT_DROP_MIN_BASELINE = 4;

/** Visits in the last 14 days vs. half the visits in the 28 days before (same length). */
export function visitDrop(
  recent14: number,
  previous28: number,
): { dropPercent: number; expected: number } | null {
  if (previous28 < VISIT_DROP_MIN_BASELINE) return null;
  const expected = previous28 / 2;
  const drop = Math.round(((expected - recent14) / expected) * 100);
  return { dropPercent: Math.max(0, drop), expected };
}

export function flagReason(
  kind: RetentionKind,
  threshold: number,
  facts: Record<string, number | string | null>,
): string {
  switch (kind) {
    case "NO_VISIT":
      return facts.days === null
        ? `No visit since joining (rule: ${threshold} days)`
        : `No visit for ${facts.days} days (rule: ${threshold})`;
    case "VISIT_DROP":
      return `${facts.recent} visits in 14 days vs usual ${facts.expected} (−${facts.dropPercent}%, rule: ${threshold}%)`;
    case "EXPIRING":
      return `Membership ends in ${facts.days} day(s), not renewed (rule: ${threshold})`;
    case "OVERDUE":
      return `Invoice ${facts.number} overdue ${facts.days} days (rule: ${threshold})`;
    case "UNUSED_CREDITS":
      return `${facts.credits} class credits left, membership ends in ${facts.days} day(s) (rule: ${threshold})`;
    case "TRIAL_FOLLOW_UP":
      return `Trial ${facts.days} days ago, no contact since (rule: ${threshold})`;
  }
}

/** "Associated, not causal": a recovery counts if it happened within this many days of the flag. */
export const RECOVERY_WINDOW_DAYS = 30;
