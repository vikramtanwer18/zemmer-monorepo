import { Prisma } from "@gym/db";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
} from "../authz";
import { bumpUsage, checkQuota } from "../entitlements";
import { AppError } from "../errors";
import { parseInput } from "../validation";
import { guard, inTenant, type CoreDeps } from "./deps";
import { branchInputSchema } from "./schemas";

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/** Branches the user may see (`branches.view`), active first. */
export async function listBranches(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "branches.view");
  const allowed = allowedBranchIds(ctx, "branches.view");
  return inTenant(deps, ctx, (tx) =>
    tx.branch.findMany({
      where: allowed === "ALL" ? {} : { id: { in: allowed } },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    }),
  );
}

export async function getBranch(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId: string,
) {
  requirePermission(ctx, "branches.view", { branchId });
  const branch = await inTenant(deps, ctx, (tx) =>
    tx.branch.findUnique({ where: { id: branchId } }),
  );
  if (!branch) throw new AppError("NOT_FOUND", "Branch not found.");
  return branch;
}

/** Creates a branch within the plan's `branches.max`. */
export async function createBranch(
  deps: CoreDeps,
  ctx: AuthContext,
  rawInput: unknown,
) {
  const ent = await guard(deps, ctx, {
    permission: "branches.manage",
    write: true,
  });
  const input = parseInput(branchInputSchema, rawInput);
  try {
    return await inTenant(deps, ctx, async (tx) => {
      await checkQuota(tx, ent, ctx.tenantId, "branches.max", 1);
      const branch = await tx.branch.create({
        data: { ...input, tenantId: ctx.tenantId },
      });
      await bumpUsage(tx, ctx.tenantId, "branches.max", 1);
      await recordAudit(tx, ctx, {
        action: "branch.created",
        entityType: "Branch",
        entityId: branch.id,
        branchId: branch.id,
        after: branch,
      });
      return branch;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError("CONFLICT", "Another branch already uses that code.", {
        fields: { code: ["Another branch already uses that code."] },
      });
    }
    throw err;
  }
}

export async function updateBranch(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId: string,
  rawInput: unknown,
) {
  await guard(deps, ctx, { permission: "branches.manage", write: true });
  const input = parseInput(branchInputSchema, rawInput);
  try {
    return await inTenant(deps, ctx, async (tx) => {
      const before = await tx.branch.findUnique({ where: { id: branchId } });
      if (!before) throw new AppError("NOT_FOUND", "Branch not found.");
      const after = await tx.branch.update({
        where: { id: branchId },
        data: input,
      });
      await recordAudit(tx, ctx, {
        action: "branch.updated",
        entityType: "Branch",
        entityId: branchId,
        branchId,
        before,
        after,
      });
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError("CONFLICT", "Another branch already uses that code.", {
        fields: { code: ["Another branch already uses that code."] },
      });
    }
    throw err;
  }
}

/** Archives (never deletes) a branch. The last active branch cannot be archived. */
export async function setBranchArchived(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId: string,
  archived: boolean,
) {
  const ent = await guard(deps, ctx, {
    permission: "branches.manage",
    write: true,
  });
  return inTenant(deps, ctx, async (tx) => {
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new AppError("NOT_FOUND", "Branch not found.");
    const target = archived ? "ARCHIVED" : "ACTIVE";
    if (branch.status === target) return branch;
    if (archived) {
      const active = await tx.branch.count({ where: { status: "ACTIVE" } });
      if (active <= 1) {
        throw new AppError("CONFLICT", "You need at least one active branch.");
      }
    } else {
      await checkQuota(tx, ent, ctx.tenantId, "branches.max", 1);
    }
    const after = await tx.branch.update({
      where: { id: branchId },
      data: { status: target },
    });
    await bumpUsage(tx, ctx.tenantId, "branches.max", archived ? -1 : 1);
    await recordAudit(tx, ctx, {
      action: archived ? "branch.archived" : "branch.restored",
      entityType: "Branch",
      entityId: branchId,
      branchId,
    });
    return after;
  });
}
