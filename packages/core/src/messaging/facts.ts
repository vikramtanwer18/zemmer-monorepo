import type { TenantTransaction } from "@gym/db";
import { invoiceBalances } from "../billing/service";
import { formatMoney } from "../money";
import { diffDays, fromDbDate, todayIn } from "../time/dates";
import type { SubjectFacts } from "./variables";

function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/**
 * Template values for one member or lead: names, gym, branch, the current (or last) plan and
 * its end date, money owed, the next trial. Only fields in VARIABLE_SOURCES; never health data.
 */
export async function factsForSubjectTx(
  tx: TenantTransaction,
  tenantId: string,
  subject: { memberId?: string | null; leadId?: string | null },
  now: Date,
): Promise<SubjectFacts> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { displayName: true, timezone: true },
  });
  const facts: SubjectFacts = { gym_name: tenant.displayName };
  const today = todayIn(tenant.timezone, now);
  if (subject.memberId) {
    const m = await tx.memberProfile.findUnique({
      where: { id: subject.memberId },
      select: {
        firstName: true,
        lastName: true,
        memberCode: true,
        homeBranch: { select: { name: true } },
        memberships: {
          where: { status: { in: ["ACTIVE", "PAUSED", "EXPIRED"] } },
          orderBy: { endDate: "desc" },
          take: 1,
          select: { endDate: true, plan: { select: { name: true } } },
        },
        invoices: {
          where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
          select: { id: true },
        },
      },
    });
    if (!m) return facts;
    facts.first_name = m.firstName;
    facts.full_name = [m.firstName, m.lastName].filter(Boolean).join(" ");
    facts.member_code = m.memberCode;
    facts.branch_name = m.homeBranch.name;
    const ms = m.memberships[0];
    if (ms) {
      const end = fromDbDate(ms.endDate);
      facts.plan_name = ms.plan.name;
      facts.end_date = formatDate(end);
      facts.days_left = String(Math.max(0, diffDays(today, end)));
    }
    if (m.invoices.length) {
      const balances = await invoiceBalances(
        tx,
        m.invoices.map((i) => i.id),
      );
      const due = [...balances.values()].reduce(
        (s, b) => s + b.outstandingMinor,
        0,
      );
      facts.amount_due = formatMoney({ amountMinor: due, currency: "INR" });
    } else facts.amount_due = formatMoney({ amountMinor: 0, currency: "INR" });
  } else if (subject.leadId) {
    const l = await tx.lead.findUnique({
      where: { id: subject.leadId },
      select: {
        firstName: true,
        lastName: true,
        branch: { select: { name: true } },
        trials: {
          where: { status: "BOOKED" },
          orderBy: { startsAt: "asc" },
          take: 1,
          select: { startsAt: true },
        },
      },
    });
    if (!l) return facts;
    facts.first_name = l.firstName;
    facts.full_name = [l.firstName, l.lastName].filter(Boolean).join(" ");
    facts.branch_name = l.branch.name;
    const trial = l.trials[0];
    if (trial)
      facts.trial_time = new Intl.DateTimeFormat("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: tenant.timezone,
      }).format(trial.startsAt);
  }
  return facts;
}
