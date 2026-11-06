import "server-only";
import {
  allowedBranchIds,
  hasPermission,
  type AuthContext,
} from "@gym/core/authz";
import { listCategories, listRooms } from "@gym/core/classes";
import { listPlans } from "@gym/core/plans";
import { listTrainers } from "@gym/core/staff";
import type { TenantAccess } from "@gym/core/tenancy";
import { services } from "@/lib/services";
import type { TemplateOptions } from "./template-form";

/** Pickers for the class forms, limited to branches where the user manages classes. */
export async function classFormOptions(
  ctx: AuthContext,
  access: Pick<TenantAccess, "branches">,
): Promise<TemplateOptions> {
  const { deps } = services();
  const allowed = allowedBranchIds(ctx, "classes.manage");
  const branches = access.branches.filter(
    (b) => allowed === "ALL" || allowed.includes(b.id),
  );
  const [categories, trainers, rooms, plans] = [
    await listCategories(deps, ctx),
    await listTrainers(deps, ctx),
    await listRooms(deps, ctx),
    hasPermission(ctx, "memberships.view") ? await listPlans(deps, ctx) : [],
  ];
  return {
    branches: branches.map((b) => ({ id: b.id, name: b.name })),
    categories,
    trainers,
    rooms: rooms.filter((r) => branches.some((b) => b.id === r.branchId)),
    planCodes: plans.map((p) => ({ code: p.code, name: p.name })),
  };
}
