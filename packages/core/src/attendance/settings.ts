import { z } from "zod";
import { recordAudit } from "../audit";
import { requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";

/** M3 floor rules (check-in, classes, PT) and per-branch check-out. settings.view to read. */
export async function getFloorSettings(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "settings.view" });
  return inTenant(deps, ctx, async (tx) => {
    const s = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    const branches = await tx.branch.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, checkoutEnabled: true },
    });
    return {
      checkinDuplicateMinutes: s?.checkinDuplicateMinutes ?? 2,
      duesAtCheckin: s?.duesAtCheckin ?? "WARN",
      autoMarkClassAttendance: s?.autoMarkClassAttendance ?? true,
      bookingReminderHours: s?.bookingReminderHours ?? 2,
      lateCancelForfeitsCredit: s?.lateCancelForfeitsCredit ?? true,
      ptNoShowConsumesSession: s?.ptNoShowConsumesSession ?? true,
      ptCancelCutoffHours: s?.ptCancelCutoffHours ?? 12,
      branches,
    };
  });
}

const bool = z
  .union([
    z.boolean(),
    z.literal("on"),
    z.literal("true"),
    z.literal("false"),
    z.literal(""),
  ])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

const floorSchema = z.object({
  checkinDuplicateMinutes: z.coerce.number().int().min(0).max(1440),
  duesAtCheckin: z.enum(["WARN", "BLOCK"]),
  autoMarkClassAttendance: bool,
  bookingReminderHours: z.coerce.number().int().min(0).max(168),
  lateCancelForfeitsCredit: bool,
  ptNoShowConsumesSession: bool,
  ptCancelCutoffHours: z.coerce.number().int().min(0).max(168),
  /** Branch ids with check-out turned on (the rest off). */
  checkoutBranchIds: z.preprocess(
    (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]),
    z.array(z.uuid()),
  ),
});

export async function updateFloorSettings(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "settings.manage", write: true });
  const input = parseInput(floorSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const before = await tx.tenantSettings.findUnique({
      where: { tenantId: ctx.tenantId },
    });
    if (!before) throw new AppError("NOT_FOUND", "Settings not found.");
    const { checkoutBranchIds, ...settings } = input;
    await tx.tenantSettings.update({
      where: { tenantId: ctx.tenantId },
      data: settings,
    });
    const branches = await tx.branch.findMany({
      select: { id: true, checkoutEnabled: true },
    });
    for (const b of branches) {
      const want = checkoutBranchIds.includes(b.id);
      if (b.checkoutEnabled !== want) {
        requirePermission(ctx, "settings.manage");
        await tx.branch.update({
          where: { id: b.id },
          data: { checkoutEnabled: want },
        });
      }
    }
    await recordAudit(tx, ctx, {
      action: "settings.floor_updated",
      entityType: "TenantSettings",
      entityId: ctx.tenantId,
      before: {
        checkinDuplicateMinutes: before.checkinDuplicateMinutes,
        duesAtCheckin: before.duesAtCheckin,
        autoMarkClassAttendance: before.autoMarkClassAttendance,
        bookingReminderHours: before.bookingReminderHours,
        lateCancelForfeitsCredit: before.lateCancelForfeitsCredit,
        ptNoShowConsumesSession: before.ptNoShowConsumesSession,
        ptCancelCutoffHours: before.ptCancelCutoffHours,
        checkoutBranchIds: branches
          .filter((b) => b.checkoutEnabled)
          .map((b) => b.id),
      },
      after: input,
    });
  });
}
