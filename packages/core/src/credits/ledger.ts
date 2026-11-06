import type { TenantTransaction } from "@gym/db";
import { AppError } from "../errors";

/**
 * Class credits and PT sessions (EntitlementLedger). A balance is always the sum of the rows —
 * never a stored number — and every movement names its reason and source, so it can be audited.
 */
export type LedgerRow = { delta: number; reason: string };

export function ledgerBalance(rows: readonly LedgerRow[]): number {
  return rows.reduce((sum, r) => sum + r.delta, 0);
}

/**
 * Class credits a plan grants per membership: a number, or null for unlimited (the M2 plan
 * `entitlements` JSON: { classCredits?: number | null }).
 */
export function classCreditsOf(entitlements: unknown): number | null {
  if (!entitlements || typeof entitlements !== "object") return null;
  const value = (entitlements as Record<string, unknown>).classCredits;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0)
    return value;
  return null;
}

/** What a credit-using booking would leave, or why it can't happen. */
export function checkCredit(
  creditsPerMembership: number | null,
  balance: number,
): { uses: false } | { uses: true; ok: boolean; after: number } {
  if (creditsPerMembership === null) return { uses: false };
  return { uses: true, ok: balance >= 1, after: balance - 1 };
}

/** Locks the membership row so two bookings by the same member can't spend the last credit twice. */
export async function lockMembership(
  tx: TenantTransaction,
  membershipId: string,
) {
  await tx.$queryRaw`SELECT id FROM app.membership WHERE id = ${membershipId}::uuid FOR UPDATE`;
}

/**
 * Makes sure the membership's credits have been granted (once — a partial unique index makes this
 * idempotent) and returns the current balance.
 */
export async function classCreditBalance(
  tx: TenantTransaction,
  tenantId: string,
  membership: { id: string; memberId: string },
  creditsPerMembership: number,
): Promise<number> {
  if (creditsPerMembership > 0) {
    await tx.entitlementLedger.createMany({
      data: [
        {
          tenantId,
          memberId: membership.memberId,
          kind: "CLASS_CREDIT",
          membershipId: membership.id,
          delta: creditsPerMembership,
          reason: "GRANT",
        },
      ],
      skipDuplicates: true,
    });
  }
  const sum = await tx.entitlementLedger.aggregate({
    where: { membershipId: membership.id, kind: "CLASS_CREDIT" },
    _sum: { delta: true },
  });
  return sum._sum.delta ?? 0;
}

export async function ptSessionBalance(
  tx: TenantTransaction,
  balanceId: string,
): Promise<number> {
  const sum = await tx.entitlementLedger.aggregate({
    where: { ptBalanceId: balanceId, kind: "PT_SESSION" },
    _sum: { delta: true },
  });
  return sum._sum.delta ?? 0;
}

export function requireCredit(ok: boolean, message: string) {
  if (!ok) throw new AppError("CONFLICT", message);
}
