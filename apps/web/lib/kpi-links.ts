import type { KpiKey } from "@gym/core/metrics";

/** Where each KPI's records live, filtered to the same period/branch when the list supports it. */
export function kpiHref(
  key: KpiKey,
  scope: { from: string; to: string; branchIds: string[] | null },
): string | null {
  const one = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;
  const b = one ? `&branchId=${one}` : "";
  const period = `from=${scope.from}&to=${scope.to}${b}`;
  const report = (k: string) => `/reports/${k}?${period}`;
  switch (key) {
    case "members.total":
      return `/members?status=ACTIVE${b}`;
    case "leads.open":
      return "/leads/board";
    case "trials.booked":
      return "/leads/trials";
    case "members.active":
      return `/members?membership=active${b}`;
    case "members.paused":
      return `/members?membership=paused${b}`;
    case "memberships.expiring":
      return `/members?expiringDays=7${b}`;
    case "members.new":
      return report("membership");
    case "members.reactivated":
    case "memberships.renewal_rate":
    case "members.churned":
      return report("renewals");
    case "members.at_risk":
      return "/retention";
    case "revenue.invoiced":
    case "revenue.net_ex_tax":
      return `/invoices?${period}`;
    case "revenue.collected":
      return `/payments?${period}`;
    case "revenue.refunds":
      return report("refunds");
    case "dues.outstanding":
    case "dues.overdue":
      return "/payments/dues";
    case "dues.collection_rate":
      return report("dues");
    case "credit.balance":
      return "/members?status=all";
    case "attendance.check_ins":
    case "attendance.unique_visits":
    case "attendance.avg_visits":
      return report("attendance");
    case "classes.occupancy":
    case "classes.no_show_rate":
      return report("classes");
    case "leads.new":
    case "leads.won":
    case "leads.conversion_rate":
      return report("leads");
    case "leads.trial_to_member":
      return report("trials");
    case "trainers.utilization":
      return report("trainers");
    case "referrals.joined":
      return report("referrals");
  }
}
