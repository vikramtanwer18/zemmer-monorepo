import type { AuthContext } from "@gym/core/authz";
import { recordPayment } from "@gym/core/billing";
import {
  createCategory,
  createClassTemplate,
  createRoom,
} from "@gym/core/classes";
import {
  assignTrainer,
  createPtPackage,
  sellPtPackage,
  setWeeklyAvailability,
  upsertTrainerProfile,
} from "@gym/core/staff";
import type { CoreDeps } from "@gym/core/tenancy";
import { todayIn } from "@gym/core/time/dates";
import { withTenant } from "@gym/db";

/**
 * M3 demo data for one gym: class categories and a room, a trainer with working hours, two
 * recurring classes (one small, to show the waitlist), a PT package sold and paid for the demo
 * member, with the trainer assigned. Skipped when the gym already has class templates.
 */
export async function seedFloorDemo(
  deps: CoreDeps,
  ctx: AuthContext,
  options: {
    branchId: string;
    trainerUserId?: string;
    memberEmail?: string;
  },
): Promise<boolean> {
  const tenantId = ctx.tenantId;
  const already = await withTenant(deps.db, tenantId, (tx) =>
    tx.classTemplate.count(),
  );
  if (already > 0) return false;

  // The demo plan includes unlimited classes (M2 plans default to "no classes").
  await withTenant(deps.db, tenantId, (tx) =>
    tx.membershipPlan.updateMany({
      where: { name: "Monthly Unlimited" },
      data: { entitlements: { classCredits: null, ptSessions: 0 } },
    }),
  );

  const yoga = await createCategory(deps, ctx, {
    name: "Yoga",
    color: "#0f766e",
  });
  const hiit = await createCategory(deps, ctx, {
    name: "HIIT",
    color: "#b45309",
  });
  const studio = await createRoom(deps, ctx, {
    branchId: options.branchId,
    name: "Studio A",
    capacity: "20",
  });

  let trainerId: string | undefined;
  if (options.trainerUserId) {
    const trainer = await upsertTrainerProfile(
      deps,
      ctx,
      options.trainerUserId,
      {
        displayName: "Coach Vikram",
        specialties: "Strength, Mobility, HIIT",
        bio: "Certified strength coach. Ten years on the floor.",
        visibleToMembers: "on",
      },
    );
    trainerId = trainer.id;
    await setWeeklyAvailability(deps, ctx, options.trainerUserId, {
      slots: [1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        from: "06:00",
        to: "20:00",
      })),
    });
  }

  const today = todayIn(ctx.timezone);
  await createClassTemplate(deps, ctx, {
    branchId: options.branchId,
    name: "Morning Yoga",
    categoryId: yoga.id,
    roomId: studio.id,
    capacity: "15",
    durationMinutes: "60",
    startTime: "06:30",
    byDays: ["1", "3", "5"],
    startDate: today,
    waitlistEnabled: "on",
  });
  await createClassTemplate(deps, ctx, {
    branchId: options.branchId,
    name: "HIIT Express",
    categoryId: hiit.id,
    trainerId,
    roomId: studio.id,
    capacity: "2",
    durationMinutes: "30",
    startTime: "18:30",
    byDays: ["2", "4"],
    startDate: today,
    waitlistEnabled: "on",
  });

  const pkg = await createPtPackage(deps, ctx, {
    name: "PT 10 sessions",
    sessionCount: "10",
    validityDays: "60",
    price: "6000",
    taxRateBps: "1800",
  });

  if (trainerId && options.memberEmail) {
    const member = await withTenant(deps.db, tenantId, (tx) =>
      tx.memberProfile.findFirst({ where: { email: options.memberEmail } }),
    );
    if (member) {
      await assignTrainer(deps, ctx, { memberId: member.id, trainerId });
      const sale = await sellPtPackage(deps, ctx, {
        memberId: member.id,
        packageId: pkg.id,
        trainerId,
      });
      const total = Number(sale.invoice.totalMinor);
      await recordPayment(deps, ctx, {
        memberId: member.id,
        branchId: options.branchId,
        method: "UPI",
        reference: "DEMO-PT-0001",
        amountMinor: total,
        allocations: [{ invoiceId: sale.invoice.id, amountMinor: total }],
      });
    }
  }
  return true;
}
