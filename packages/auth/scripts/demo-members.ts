/**
 * M2 demo data for one gym: two plans, five members covering every dashboard state, real invoices
 * and payments through the core services (so numbering, tax, allocation and audit all apply).
 * Shared by the seed script and by the KPI integration test, which asserts the dashboard figures.
 *
 * With `now` = 10:00 IST on 3 Nov 2026 and the period 1 Nov – 1 Dec, the dashboard shows:
 *   active 2 · new 1 · expiring in 7 days 1 · invoiced ₹8,000 · collected ₹3,000 · outstanding ₹5,000
 */
import type { AuthContext } from "@gym/core/authz";
import { recordPayment } from "@gym/core/billing";
import { createMember } from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import { createPlan } from "@gym/core/plans";
import type { CoreDeps } from "@gym/core/tenancy";
import { withTenant } from "@gym/db";

const DAY_MS = 86_400_000;

export type DemoMembersResult = {
  skipped: boolean;
  members: number;
};

export async function seedDemoMembers(
  deps: CoreDeps,
  ctx: AuthContext,
  options: {
    branchId: string;
    /** Links member profiles to existing accounts (email → userId) so they can open the member app. */
    accounts?: Map<string, string>;
    /** Email of the fully paid, active member (default ankit@example.test). */
    activeMemberEmail?: string;
  },
): Promise<DemoMembersResult> {
  const existing = await withTenant(deps.db, ctx.tenantId, (tx) =>
    tx.membershipPlan.count(),
  );
  if (existing > 0) return { skipped: true, members: 0 };

  const now = deps.now?.() ?? new Date();
  const monthly = await createPlan(deps, ctx, {
    name: "Monthly Unlimited",
    price: "1500",
    joiningFee: "500",
    durationUnit: "MONTH",
    durationCount: "1",
    taxRateBps: "1800",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    freezeMaxDays: "15",
    freezeMaxTimes: "2",
    refundRule: "PRORATA",
  });
  const quarterly = await createPlan(deps, ctx, {
    name: "Quarterly",
    price: "4000",
    joiningFee: "",
    durationUnit: "MONTH",
    durationCount: "3",
    taxRateBps: "1800",
    sacCode: "999723",
    accessScope: "HOME_BRANCH",
    freezeMaxDays: "30",
    freezeMaxTimes: "2",
    refundRule: "NONE",
  });

  const member = async (
    firstName: string,
    lastName: string,
    phone: string,
    email?: string,
  ) => {
    const created = await createMember(deps, ctx, {
      firstName,
      lastName,
      phone,
      email,
      homeBranchId: options.branchId,
      marketingEmail: email ? "on" : undefined,
    });
    const userId = email ? options.accounts?.get(email) : undefined;
    if (userId) {
      await withTenant(deps.db, ctx.tenantId, (tx) =>
        tx.memberProfile.update({
          where: { id: created.id },
          data: { userId },
        }),
      );
    }
    return created;
  };

  // Paid in full today: active and new. ₹1,500 + ₹500 joining fee.
  const ankit = await member(
    "Ankit",
    "Gupta",
    "9876500001",
    options.activeMemberEmail ?? "ankit@example.test",
  );
  await sellMembership(deps, ctx, {
    memberId: ankit.id,
    planId: monthly.id,
    payment: { method: "CASH", amountMinor: 200_000 },
  });

  // Part-paid quarterly: waiting for payment, ₹3,000 outstanding.
  const meera = await member(
    "Meera",
    "Joshi",
    "9876500002",
    "meera@example.test",
  );
  await sellMembership(deps, ctx, {
    memberId: meera.id,
    planId: quarterly.id,
    payment: {
      method: "UPI",
      amountMinor: 100_000,
      reference: "UPI-DEMO-0001",
    },
  });

  // Sold, nothing paid yet: ₹2,000 outstanding.
  const rohan = await member("Rohan", "Singh", "9876500003");
  await sellMembership(deps, ctx, { memberId: rohan.id, planId: monthly.id });

  // Joined 25 days ago and paid then: active, ends within the week, not new this period.
  const earlier = { ...deps, now: () => new Date(now.getTime() - 25 * DAY_MS) };
  const dev = await member("Dev", "Malhotra", "9876500004");
  await sellMembership(earlier, ctx, { memberId: dev.id, planId: monthly.id });
  await recordPayment(earlier, ctx, {
    memberId: dev.id,
    method: "CASH",
    amountMinor: 200_000,
  });

  // A lead who hasn't bought anything.
  await member("Isha", "Patel", "9876500005", "isha@example.test");

  return { skipped: false, members: 5 };
}
