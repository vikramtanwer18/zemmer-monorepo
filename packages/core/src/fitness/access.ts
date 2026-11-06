import { withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { hasPermission, type AuthContext } from "../authz";
import { checkEntitlement, type BooleanFeature } from "../entitlements";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { isMyClient } from "../staff/assignments";
import { entitlementsFor, guard, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";

/**
 * Health and fitness data (M7 §1, spec §13): stored only after the member's own health-data
 * consent, separate from marketing. Who may read a member's data:
 *   - the member;
 *   - a trainer currently assigned to them (fitness.manage + the assignment);
 *   - Owner/Admin (fitness.view_all).
 * members.view is NOT enough: receptionists, sales and accountants see nothing. Staff reads of a
 * member's fitness data are audited.
 */

export const HEALTH_CONSENT_VERSION = "2026-11-v1";
export const HEALTH_CONSENT_TEXT =
  "I agree that {gym} may store the fitness and health information I or my trainer record (workouts, body measurements, assessments, goals, food and water logs). Only I, the trainer assigned to me and the gym's owner or administrators can see it. It is never used for marketing. I can withdraw this at any time in Privacy settings; after that nothing new is recorded and staff can no longer see it.";

export type FitnessFeature = Extract<
  BooleanFeature,
  "workouts.enabled" | "nutrition.enabled" | "rewards.enabled"
>;

export async function healthConsentTx(tx: TenantTransaction, memberId: string) {
  const latest = await tx.healthDataConsent.findFirst({
    where: { memberId },
    orderBy: { capturedAt: "desc" },
  });
  return {
    granted: latest?.status === "GRANTED",
    at: latest?.capturedAt ?? null,
    version: latest?.version ?? null,
  };
}

export async function requireHealthConsentTx(
  tx: TenantTransaction,
  memberId: string,
) {
  const c = await healthConsentTx(tx, memberId);
  if (!c.granted)
    throw new AppError(
      "CONFLICT",
      "The member hasn't agreed to store fitness and health data yet. They can do it in the member app (Privacy).",
      {
        details: { code: "HEALTH_CONSENT_REQUIRED" },
      },
    );
}

async function memberFeature(
  deps: CoreDeps,
  tenantId: string,
  feature: FitnessFeature,
) {
  checkEntitlement(await entitlementsFor(deps, tenantId), feature);
}

/** Member side: their own data, behind the plan feature (and consent for writes). */
export async function inMemberFitness<T>(
  deps: CoreDeps,
  mctx: MemberContext,
  feature: FitnessFeature,
  options: { write?: boolean },
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  await memberFeature(deps, mctx.tenantId, feature);
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      if (options.write) await requireHealthConsentTx(tx, mctx.memberId);
      return fn(tx);
    },
    { userId: mctx.userId },
  );
}

export type StaffAccess = { via: "TRAINER" | "VIEW_ALL"; canWrite: boolean };

/**
 * Staff side. Not-found (not forbidden) for members outside the caller's reach, so staff can't
 * probe who has fitness data.
 */
export async function staffFitnessAccessTx(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
  mode: "read" | "write",
): Promise<StaffAccess> {
  const member = await tx.memberProfile.findUnique({
    where: { id: memberId },
    select: { id: true, anonymizedAt: true },
  });
  if (!member || member.anonymizedAt)
    throw new AppError("NOT_FOUND", "Member not found.");
  const manage = hasPermission(ctx, "fitness.manage");
  const viewAll = hasPermission(ctx, "fitness.view_all");
  const assigned = manage ? await isMyClient(tx, ctx, memberId) : false;
  if (!viewAll && !assigned)
    throw new AppError("NOT_FOUND", "Member not found.");
  const canWrite = manage && (assigned || viewAll);
  if (mode === "write" && !canWrite)
    throw new AppError(
      "FORBIDDEN",
      "Only the member's trainer can change their plan.",
    );
  // Consent covers staff seeing it at all.
  await requireHealthConsentTx(tx, memberId);
  return { via: assigned ? "TRAINER" : "VIEW_ALL", canWrite };
}

/** guard + access + (for reads of the member's record) an audit row. */
export async function inStaffFitness<T>(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  feature: FitnessFeature,
  mode: "read" | "write",
  fn: (tx: TenantTransaction, access: StaffAccess) => Promise<T>,
  audit?: { action: string },
): Promise<T> {
  // The permission is checked in staffFitnessAccessTx (assignment or view_all), not by role.
  await guard(deps, ctx, {
    permission: hasPermission(ctx, "fitness.view_all")
      ? "fitness.view_all"
      : "fitness.manage",
    entitlement: feature,
    write: mode === "write",
  });
  return withTenant(
    deps.db,
    ctx.tenantId,
    async (tx) => {
      const access = await staffFitnessAccessTx(tx, ctx, memberId, mode);
      if (audit)
        await recordAudit(tx, ctx, {
          action: audit.action,
          entityType: "MemberProfile",
          entityId: memberId,
          meta: { via: access.via },
        });
      return fn(tx, access);
    },
    { userId: ctx.userId },
  );
}

// --- consent screens -----------------------------------------------------------------------------

export async function getMyHealthConsent(deps: CoreDeps, mctx: MemberContext) {
  return withTenant(deps.db, mctx.tenantId, async (tx) => ({
    ...(await healthConsentTx(tx, mctx.memberId)),
    text: HEALTH_CONSENT_TEXT.replace("{gym}", mctx.tenantName),
    currentVersion: HEALTH_CONSENT_VERSION,
  }));
}

/** The member agrees or withdraws (their own words are the evidence). */
export async function setMyHealthConsent(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { granted } = parseInput(
    z.object({
      granted: z.preprocess(
        (v) => v === true || v === "on" || v === "true",
        z.boolean(),
      ),
    }),
    raw,
  );
  return withTenant(
    deps.db,
    mctx.tenantId,
    async (tx) => {
      await tx.healthDataConsent.create({
        data: {
          tenantId: mctx.tenantId,
          memberId: mctx.memberId,
          status: granted ? "GRANTED" : "REVOKED",
          version: HEALTH_CONSENT_VERSION,
          evidence: granted
            ? HEALTH_CONSENT_TEXT.replace("{gym}", mctx.tenantName)
            : "Withdrawn by the member in the app.",
          method: "SELF_SERVICE",
          capturedAt: nowOf(deps),
        },
      });
      await recordAudit(
        tx,
        { userId: mctx.userId, tenantId: mctx.tenantId },
        {
          action: granted ? "health_consent.granted" : "health_consent.revoked",
          entityType: "MemberProfile",
          entityId: mctx.memberId,
          meta: { version: HEALTH_CONSENT_VERSION },
        },
      );
    },
    { userId: mctx.userId },
  );
}

/** For staff screens: may this member's fitness data be shown/edited here, and why not. */
export async function fitnessAccessSummary(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const viewAll = hasPermission(ctx, "fitness.view_all");
    const manage = hasPermission(ctx, "fitness.manage");
    const assigned = manage ? await isMyClient(tx, ctx, memberId) : false;
    const consent = await healthConsentTx(tx, memberId);
    const m = await tx.memberProfile.findUnique({
      where: { id: memberId },
      select: {
        firstName: true,
        lastName: true,
        memberCode: true,
        anonymizedAt: true,
      },
    });
    const allowed = !!m && !m.anonymizedAt && (viewAll || assigned);
    return {
      allowed,
      canWrite: allowed && manage,
      consent: consent.granted,
      name: allowed
        ? [m!.firstName, m!.lastName].filter(Boolean).join(" ")
        : null,
      memberCode: allowed ? m!.memberCode : null,
      canExport: hasPermission(ctx, "fitness.export"),
    };
  });
}

/** Owner/Admin (fitness.view_all): find any member to open their fitness page. */
export async function searchMembersForFitness(
  deps: CoreDeps,
  ctx: AuthContext,
  q: string,
) {
  await guard(deps, ctx, {
    permission: "fitness.view_all",
    entitlement: "workouts.enabled",
  });
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return [];
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const rows = await tx.memberProfile.findMany({
      where: {
        anonymizedAt: null,
        status: { not: "ARCHIVED" },
        OR: [
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
          { memberCode: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, memberCode: true },
      take: 20,
      orderBy: { firstName: "asc" },
    });
    const consents = await Promise.all(
      rows.map((r) => healthConsentTx(tx, r.id)),
    );
    return rows.map((r, i) => ({ ...r, consent: consents[i]!.granted }));
  });
}
