import { createHmac, timingSafeEqual } from "node:crypto";
import { withTenant } from "@gym/db";
import { z } from "zod";
import type { AuthContext } from "../authz";
import { AppError } from "../errors";
import { parseInput } from "../validation";
import { guard, nowOf, type CoreDeps } from "../tenancy/deps";
import { listPrices } from "./service";

/**
 * The gym owner's billing page (apps/web, gym_app role): current plan, trial, period, prices and
 * this gym's SaaS invoices. Changing the subscription goes through the admin app (which alone
 * holds the platform payment account) via a signed internal request — see signInternalRequest.
 */
export async function getMyBilling(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "subscription.view" });
  const now = nowOf(deps);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const sub = await tx.tenantSubscription.findUnique({
      where: { tenantId: ctx.tenantId },
      include: { plan: true, price: true },
    });
    const pendingPlan = sub?.pendingPlanId
      ? await tx.saasPlan.findUnique({ where: { id: sub.pendingPlanId } })
      : null;
    const invoices = await tx.platformInvoice.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { issueDate: "desc" },
      take: 24,
    });
    const prices = await listPrices(tx);
    return {
      status: sub?.status ?? null,
      plan: sub
        ? { id: sub.plan.id, code: sub.plan.code, name: sub.plan.name }
        : null,
      cycle: sub?.price?.cycle ?? null,
      amountMinor: sub?.price ? Number(sub.price.amountMinor) : null,
      trialEndsAt: sub?.trialEndsAt ?? null,
      trialDaysLeft:
        sub?.status === "TRIALING" && sub.trialEndsAt
          ? Math.max(
              Math.ceil(
                (sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000,
              ),
              0,
            )
          : null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      graceEndsAt: sub?.graceEndsAt ?? null,
      hasProviderSubscription: !!sub?.providerSubscriptionId,
      pendingPlan: pendingPlan ? pendingPlan.name : null,
      prices,
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        issueDate: i.issueDate,
        description: i.description,
        totalMinor: Number(i.totalMinor),
        taxMinor: Number(i.cgstMinor + i.sgstMinor + i.igstMinor),
        status: i.status,
      })),
    };
  });
}

// --- signed web → admin requests (subscription checkout/cancel) -----------------------------

const MAX_SKEW_MS = 5 * 60_000;

/** HMAC over method, path, timestamp and body with a shared secret (PLATFORM_INTERNAL_SECRET). */
export function signInternalRequest(
  secret: string,
  path: string,
  body: string,
  timestamp = Date.now(),
) {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.POST.${path}.${body}`)
    .digest("hex");
  return {
    "x-internal-timestamp": String(timestamp),
    "x-internal-signature": mac,
  };
}

export function verifyInternalRequest(
  secret: string,
  path: string,
  body: string,
  headers: { timestamp: string | null; signature: string | null },
  now = Date.now(),
): boolean {
  const ts = Number(headers.timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(now - ts) > MAX_SKEW_MS ||
    !headers.signature
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${ts}.POST.${path}.${body}`)
    .digest("hex");
  return (
    expected.length === headers.signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(headers.signature))
  );
}

// --- owner actions (web side): checked here, carried out by the admin app ------------------

export type InternalTransport = {
  adminUrl: string;
  secret: string;
  fetch?: typeof fetch;
};

export const INTERNAL_PATHS = {
  checkout: "/api/internal/billing/checkout",
  cancel: "/api/internal/billing/cancel",
} as const;

async function callAdmin<T>(
  transport: InternalTransport,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const body = JSON.stringify(payload);
  const doFetch = transport.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${transport.adminUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signInternalRequest(transport.secret, path, body),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AppError(
      "PROVIDER_ERROR",
      "Billing is unreachable right now. Try again in a minute.",
    );
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!res.ok)
    throw new AppError(
      res.status === 404
        ? "NOT_FOUND"
        : res.status === 409
          ? "CONFLICT"
          : "PROVIDER_ERROR",
      json.error ?? "Billing couldn't do that. Try again in a minute.",
    );
  return json;
}

/**
 * Owner picks a plan and cycle (subscription.manage). Allowed while suspended or past due: paying
 * is how a gym gets out of read-only. The admin app re-reads everything from the database.
 */
export async function changeMySubscription(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  transport: InternalTransport,
) {
  await guard(deps, ctx, { permission: "subscription.manage" });
  const { priceId } = parseInput(
    z.object({ priceId: z.uuid("Pick a plan.") }),
    raw,
  );
  return callAdmin<
    | { kind: "checkout"; url: string }
    | { kind: "changed"; when: "now" | "cycle_end" }
  >(transport, INTERNAL_PATHS.checkout, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    priceId,
  });
}

export async function cancelMySubscription(
  deps: CoreDeps,
  ctx: AuthContext,
  transport: InternalTransport,
) {
  await guard(deps, ctx, { permission: "subscription.manage" });
  return callAdmin<{ ok: true }>(transport, INTERNAL_PATHS.cancel, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });
}

/** What the admin app accepts (after the signature is verified). */
export const internalCheckoutSchema = z.object({
  tenantId: z.uuid(),
  userId: z.string().min(1),
  priceId: z.uuid(),
});
export const internalCancelSchema = z.object({
  tenantId: z.uuid(),
  userId: z.string().min(1),
});
