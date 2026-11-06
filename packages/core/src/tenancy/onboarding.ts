import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@gym/db";
import { withTenant } from "@gym/db";
import { recordAudit } from "../audit";
import { bumpUsage } from "../entitlements";
import { AppError } from "../errors";
import { readPlatformSettings } from "../platform-settings";
import { parseInput } from "../validation";
import { nowOf, type CoreDeps } from "./deps";
import { onboardingSchema } from "./schemas";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "gym";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest ACTIVE version of a plan code. */
export async function findActivePlan(
  db: Pick<PrismaClient, "saasPlan">,
  code: string,
) {
  return db.saasPlan.findFirst({
    where: { code, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });
}

export type OnboardingResult = {
  tenantId: string;
  status: "ACTIVE" | "PENDING_APPROVAL";
};

/**
 * Owner self-signup: creates tenant, subscription (trial), settings, first branch, membership and
 * owner role in one transaction. When the platform requires approval the tenant starts as
 * PENDING_APPROVAL and the trial clock starts at approval instead.
 */
export async function createTenantForOwner(
  deps: CoreDeps,
  owner: {
    userId: string;
    request?: { ip?: string | null; userAgent?: string | null };
  },
  rawInput: unknown,
): Promise<OnboardingResult> {
  const input = parseInput(onboardingSchema, rawInput);
  const now = nowOf(deps);
  const settings = await readPlatformSettings(deps.db);
  const plan = await findActivePlan(deps.db, settings["trial.plan_code"]);
  if (!plan) {
    throw new AppError("INTERNAL", "No trial plan is configured.");
  }
  const pending = settings["tenant.approval_required"];
  const tenantId = randomUUID();
  const baseSlug = slugify(input.gymName);

  await withTenant(
    deps.db,
    tenantId,
    async (tx) => {
      // The slug is unique across tenants this user cannot see, so insert with ON CONFLICT and
      // retry with a suffix rather than reading other tenants' slugs.
      let slug = baseSlug;
      for (let attempt = 0; ; attempt++) {
        const inserted = await tx.$executeRaw`
          INSERT INTO platform.tenant
            (id, slug, legal_name, display_name, status, country, timezone, currency, locale,
             approved_at, created_at, updated_at)
          VALUES
            (${tenantId}::uuid, ${slug}, ${input.legalName || input.gymName}, ${input.gymName},
             ${pending ? "PENDING_APPROVAL" : "ACTIVE"}::platform."TenantStatus", 'IN',
             ${input.timezone}, ${input.currency}, 'en-IN',
             ${pending ? null : now}, ${now}, ${now})
          ON CONFLICT (slug) DO NOTHING`;
        if (inserted === 1) break;
        if (attempt >= 5)
          throw new AppError(
            "CONFLICT",
            "Could not pick a unique gym address.",
          );
        slug = `${baseSlug.slice(0, 33)}-${randomUUID().slice(0, 6)}`;
      }

      await tx.tenantSubscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: "TRIALING",
          trialEndsAt: pending
            ? null
            : new Date(now.getTime() + settings["trial.days"] * DAY_MS),
        },
      });
      await tx.tenantSettings.create({
        data: { tenantId, stateCode: input.stateCode },
      });
      const branch = await tx.branch.create({
        data: {
          tenantId,
          name: input.branchName,
          code: "MAIN",
          city: input.branchCity,
          addressLine1: input.branchAddress,
          stateCode: input.stateCode,
        },
      });
      const membership = await tx.tenantMembership.create({
        data: { tenantId, userId: owner.userId },
      });
      await tx.roleAssignment.create({
        data: {
          tenantId,
          membershipId: membership.id,
          roleKey: "GYM_OWNER",
          branchId: null,
        },
      });
      await bumpUsage(tx, tenantId, "branches.max", 1);
      await bumpUsage(tx, tenantId, "staff.max", 1);
      await recordAudit(
        tx,
        { userId: owner.userId, tenantId, request: owner.request },
        {
          action: "tenant.created",
          entityType: "Tenant",
          entityId: tenantId,
          after: {
            displayName: input.gymName,
            plan: `${plan.code}@${plan.version}`,
            status: pending ? "PENDING_APPROVAL" : "ACTIVE",
            firstBranch: branch.code,
          },
        },
      );
    },
    { userId: owner.userId },
  );

  return { tenantId, status: pending ? "PENDING_APPROVAL" : "ACTIVE" };
}
