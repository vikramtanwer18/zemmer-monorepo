/**
 * Keyword routing from a question to Copilot tools. Used when the provider can't call tools
 * (fallback mode: the server picks the tools and the model only explains a structured summary),
 * and by the development/CI fake provider. Deterministic and conservative: unknown → get_kpis.
 */

export type RoutedCall = { name: string; args: Record<string, unknown> };

const has = (q: string, ...words: (string | RegExp)[]) =>
  words.some((w) => (typeof w === "string" ? q.includes(w) : w.test(q)));

function periodOf(q: string): Record<string, string> {
  if (has(q, "last week")) return { preset: "last_week" };
  if (has(q, "this week", "weekly")) return { preset: "this_week" };
  if (has(q, "last month")) return { preset: "last_month" };
  if (has(q, "today")) return { preset: "today" };
  if (has(q, "yesterday")) return { preset: "yesterday" };
  if (has(q, "this year")) return { preset: "this_year" };
  if (has(q, "90 days", "quarter")) return { preset: "last_90_days" };
  if (has(q, "30 days")) return { preset: "last_30_days" };
  return { preset: "this_month" };
}

export function routeQuestion(question: string): RoutedCall[] {
  const q = question.toLowerCase();
  const period = periodOf(q);
  if (
    has(
      q,
      /\b(what|how) (is|are|do you|does)\b.*\b(defin|calculat|mean|count)/,
      "definition of",
      "explain the",
      "how is",
      "how do you calculate",
    )
  ) {
    const key = has(q, "renewal")
      ? "memberships.renewal_rate"
      : has(q, "collection rate")
        ? "dues.collection_rate"
        : has(q, "churn")
          ? "members.churned"
          : has(q, "conversion")
            ? "leads.conversion_rate"
            : has(q, "occupancy")
              ? "classes.occupancy"
              : has(q, "utili")
                ? "trainers.utilization"
                : has(q, "collected")
                  ? "revenue.collected"
                  : has(q, "active member")
                    ? "members.active"
                    : null;
    if (key) return [{ name: "explain_metric", args: { key } }];
  }
  if (
    has(
      q,
      "expir",
      "renewal coming",
      "renewals coming",
      "due for renewal",
      "up for renewal",
    )
  )
    return [
      {
        name: "list_expiring_memberships",
        args: { days: has(q, "month", "30") ? 30 : 7 },
      },
    ];
  if (has(q, "overdue", "unpaid", "owe", "dues", "outstanding"))
    return [{ name: "list_overdue_invoices", args: {} }];
  if (
    has(
      q,
      "reconcil",
      "mismatch",
      "payment issue",
      "payments require",
      "payments need",
    )
  )
    return [{ name: "list_unreconciled_payments", args: {} }];
  if (
    has(
      q,
      "follow-up",
      "follow up",
      "followup",
      "need a call",
      "needs a call",
      "uncontacted",
      "not contacted",
      "contacted yet",
      "never contacted",
      /nobody (has )?(called|contacted)/,
    )
  )
    return [{ name: "list_leads_needing_followup", args: {} }];
  if (has(q, "campaign"))
    return [{ name: "campaign_performance", args: period }];
  if (
    has(
      q,
      "attendance",
      "footfall",
      "visits",
      "check-in",
      "checkins",
      "check ins",
    ) &&
    has(q, "branch", "declin", "drop", "trend")
  )
    return [{ name: "branch_attendance_trend", args: period }];
  if (
    has(
      q,
      "summar",
      "how did we do",
      "how are we doing",
      "overview",
      "performance",
    )
  )
    return [
      {
        name: "weekly_summary",
        args: { week: has(q, "last week") ? "last_week" : "this_week" },
      },
    ];
  if (
    has(
      q,
      "why",
      "change",
      "compare",
      "vs",
      "versus",
      "previous",
      "up or down",
      "drop",
      "increase",
    )
  )
    return [{ name: "compare_periods", args: { keys: keysFor(q), ...period } }];
  return [{ name: "get_kpis", args: { keys: keysFor(q), ...period } }];
}

function keysFor(q: string): string[] {
  const keys: string[] = [];
  if (has(q, "revenue", "money", "income", "sales", "collect"))
    keys.push("revenue.invoiced", "revenue.collected", "revenue.refunds");
  if (has(q, "member", "join"))
    keys.push("members.active", "members.new", "members.churned");
  if (has(q, "renew")) keys.push("memberships.renewal_rate");
  if (has(q, "attend", "visit", "check"))
    keys.push("attendance.check_ins", "attendance.unique_visits");
  if (has(q, "lead", "conversion", "trial"))
    keys.push(
      "leads.new",
      "leads.won",
      "leads.conversion_rate",
      "leads.trial_to_member",
    );
  if (has(q, "class", "occupancy"))
    keys.push("classes.occupancy", "classes.no_show_rate");
  if (has(q, "trainer")) keys.push("trainers.utilization");
  if (has(q, "risk", "churn")) keys.push("members.at_risk", "members.churned");
  return keys.length
    ? [...new Set(keys)]
    : [
        "members.active",
        "members.new",
        "revenue.collected",
        "attendance.unique_visits",
      ];
}
