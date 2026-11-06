import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { reconcileTenant } from "./sync";

/** Staff view: recent reconciliation runs and the items still to look at (billing.view). */
export async function getReconciliation(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "billing.view" });
  return inTenant(deps, ctx, async (tx) => ({
    runs: await tx.reconciliationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
    open: await tx.reconciliationItem.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    webhooks: (
      await tx.webhookEvent.groupBy({ by: ["status"], _count: { _all: true } })
    ).map((g): { status: string; count: number } => ({
      status: g.status,
      count: g._count._all,
    })),
  }));
}

/** "Re-check now" for the whole gym (billing.view). */
export async function runReconciliationNow(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "billing.view", write: true });
  return reconcileTenant(deps, ctx.tenantId, {
    kind: "MANUAL",
    olderThanMinutes: 0,
    now: nowOf(deps),
  });
}

export async function resolveReconciliationItem(
  deps: CoreDeps,
  ctx: AuthContext,
  itemId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "billing.refund", write: true });
  const { note } = parseInput(
    z.object({ note: z.string().trim().min(3, "Say what was done.").max(300) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const item = await tx.reconciliationItem.findUnique({
      where: { id: itemId },
    });
    if (!item) throw new AppError("NOT_FOUND", "Item not found.");
    if (item.status === "RESOLVED") return item;
    const done = await tx.reconciliationItem.update({
      where: { id: item.id },
      data: {
        status: "RESOLVED",
        resolvedAt: nowOf(deps),
        resolvedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "reconciliation.item_resolved",
      entityType: "ReconciliationItem",
      entityId: item.id,
      meta: { note, issue: item.issue },
    });
    return done;
  });
}
