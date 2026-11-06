import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@gym/db";
import { withTenant, inOrder } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  hasStaffRole,
  isTenantRoleKey,
  requirePermission,
  roleLabel,
  TENANT_ROLES,
  type AuthContext,
} from "../authz";
import { bumpUsage, checkQuota } from "../entitlements";
import { AppError } from "../errors";
import { emailSchema, parseInput } from "../validation";
import { guard, inTenant, nowOf, type CoreDeps } from "./deps";
import { roleGrantsSchema, type RoleGrantInput } from "./schemas";

export const INVITATION_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Sends the invitation email. Implemented by the app with packages/integrations/email. */
export type InvitationMailer = (message: {
  to: string;
  tenantName: string;
  inviterName: string | null;
  roles: string[];
  token: string;
  expiresAt: Date;
}) => Promise<void>;

/**
 * Can this context grant these roles? Permission-based, so custom roles fit later:
 * owner needs staff.assign_owner, administrator needs staff.assign_admin, branch manager needs
 * staff.manage on every branch, everything else needs staff.invite for the target branch.
 */
export function assertCanGrantRoles(
  ctx: AuthContext,
  roles: RoleGrantInput[],
): void {
  for (const grant of roles) {
    if (!isTenantRoleKey(grant.roleKey) || !TENANT_ROLES[grant.roleKey].staff) {
      throw new AppError(
        "VALIDATION_FAILED",
        `"${grant.roleKey}" is not a staff role.`,
      );
    }
    const deny = () => {
      throw new AppError(
        "FORBIDDEN",
        `You can't grant the ${roleLabel(grant.roleKey)} role${grant.branchId ? " for that branch" : ""}.`,
      );
    };
    switch (grant.roleKey) {
      case "GYM_OWNER":
        if (
          grant.branchId !== null ||
          !hasPermission(ctx, "staff.assign_owner")
        )
          deny();
        break;
      case "GYM_ADMIN":
        if (
          grant.branchId !== null ||
          !hasPermission(ctx, "staff.assign_admin")
        )
          deny();
        break;
      case "BRANCH_MANAGER":
        if (allowedBranchIds(ctx, "staff.manage") !== "ALL") deny();
        break;
      default:
        if (grant.branchId === null) {
          if (allowedBranchIds(ctx, "staff.invite") !== "ALL") deny();
        } else if (
          !hasPermission(ctx, "staff.invite", { branchId: grant.branchId })
        ) {
          deny();
        }
    }
  }
}

function dedupeRoles(roles: RoleGrantInput[]): RoleGrantInput[] {
  const seen = new Set<string>();
  return roles.filter((r) => {
    const key = `${r.roleKey}|${r.branchId ?? "*"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const inviteSchema = z.object({
  email: emailSchema,
  roles: roleGrantsSchema,
});

export async function inviteStaff(
  deps: CoreDeps,
  mailer: InvitationMailer,
  ctx: AuthContext,
  rawInput: unknown,
) {
  const ent = await guard(deps, ctx, {
    permission: "staff.invite",
    write: true,
  });
  const input = parseInput(inviteSchema, rawInput);
  const roles = dedupeRoles(input.roles);
  assertCanGrantRoles(ctx, roles);
  const now = nowOf(deps);
  const { token, tokenHash } = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS);

  const result = await inTenant(deps, ctx, async (tx) => {
    await assertBranchesActive(tx, roles);
    const existingUser = await tx.user.findUnique({
      where: { email: input.email },
    });
    if (existingUser) {
      const membership = await tx.tenantMembership.findUnique({
        where: {
          tenantId_userId: { tenantId: ctx.tenantId, userId: existingUser.id },
        },
        include: { roles: true },
      });
      if (
        membership?.status === "ACTIVE" &&
        hasStaffRole(membership.roles.map((r) => r.roleKey))
      ) {
        throw new AppError("CONFLICT", "This person is already on your team.", {
          fields: { email: ["This person is already on your team."] },
        });
      }
    }
    // Counts active staff; a pending invite does not reserve a seat but cannot exceed one now.
    await checkQuota(tx, ent, ctx.tenantId, "staff.max", 1);

    await tx.invitation.updateMany({
      where: { email: input.email, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    const invitation = await tx.invitation.create({
      data: {
        tenantId: ctx.tenantId,
        email: input.email,
        roles,
        tokenHash,
        expiresAt,
        invitedByUserId: ctx.userId,
      },
    });
    const [tenant, inviter] = await inOrder([
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
      tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }),
    ]);
    await recordAudit(tx, ctx, {
      action: "staff.invited",
      entityType: "Invitation",
      entityId: invitation.id,
      after: { email: input.email, roles },
    });
    return {
      invitation,
      tenantName: tenant.displayName,
      inviterName: inviter?.name ?? null,
    };
  });

  await mailer({
    to: input.email,
    tenantName: result.tenantName,
    inviterName: result.inviterName,
    roles: roles.map((r) => roleLabel(r.roleKey)),
    token,
    expiresAt,
  });
  return result.invitation;
}

async function assertBranchesActive(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  roles: RoleGrantInput[],
) {
  const ids = [
    ...new Set(roles.map((r) => r.branchId).filter((id): id is string => !!id)),
  ];
  if (!ids.length) return;
  const found = await tx.branch.count({
    where: { id: { in: ids }, status: "ACTIVE" },
  });
  if (found !== ids.length) {
    throw new AppError("VALIDATION_FAILED", "Pick an active branch.");
  }
}

/** New token and expiry for a pending invitation; the old link stops working. */
export async function resendInvitation(
  deps: CoreDeps,
  mailer: InvitationMailer,
  ctx: AuthContext,
  invitationId: string,
) {
  await guard(deps, ctx, { permission: "staff.invite", write: true });
  const now = nowOf(deps);
  const { token, tokenHash } = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS);
  const result = await inTenant(deps, ctx, async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.status !== "PENDING") {
      throw new AppError("NOT_FOUND", "That invitation is no longer pending.");
    }
    const roles = roleGrantsSchema.parse(invitation.roles);
    assertCanGrantRoles(ctx, roles);
    const updated = await tx.invitation.update({
      where: { id: invitationId },
      data: { tokenHash, expiresAt },
    });
    const [tenant, inviter] = await inOrder([
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }),
      tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }),
    ]);
    await recordAudit(tx, ctx, {
      action: "staff.invitation_resent",
      entityType: "Invitation",
      entityId: invitationId,
    });
    return {
      updated,
      roles,
      tenantName: tenant.displayName,
      inviterName: inviter?.name ?? null,
    };
  });
  await mailer({
    to: result.updated.email,
    tenantName: result.tenantName,
    inviterName: result.inviterName,
    roles: result.roles.map((r) => roleLabel(r.roleKey)),
    token,
    expiresAt,
  });
  return result.updated;
}

export async function revokeInvitation(
  deps: CoreDeps,
  ctx: AuthContext,
  invitationId: string,
) {
  await guard(deps, ctx, { permission: "staff.invite", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.status !== "PENDING") {
      throw new AppError("NOT_FOUND", "That invitation is no longer pending.");
    }
    assertCanGrantRoles(ctx, roleGrantsSchema.parse(invitation.roles));
    await tx.invitation.update({
      where: { id: invitationId },
      data: { status: "REVOKED" },
    });
    await recordAudit(tx, ctx, {
      action: "staff.invitation_revoked",
      entityType: "Invitation",
      entityId: invitationId,
      before: { email: invitation.email },
    });
  });
}

export type InvitationPreview = {
  tenantName: string;
  email: string;
  roles: string[];
  state: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
};

async function findInvitation(db: PrismaClient, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const rows = await db.$queryRaw<{ id: string; tenant_id: string }[]>`
    SELECT id::text, tenant_id::text FROM app.find_invitation_by_token(${hashInvitationToken(token)})`;
  return rows[0] ?? null;
}

/** What the /invite/[token] page shows before sign-in. */
export async function getInvitationPreview(
  deps: CoreDeps,
  token: string,
): Promise<InvitationPreview | null> {
  const found = await findInvitation(deps.db, token);
  if (!found) return null;
  return withTenant(deps.db, found.tenant_id, async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: found.id },
    });
    if (!invitation) return null;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: found.tenant_id },
    });
    const roles = roleGrantsSchema.safeParse(invitation.roles);
    const expired =
      invitation.status === "PENDING" && invitation.expiresAt <= nowOf(deps);
    return {
      tenantName: tenant.displayName,
      email: invitation.email,
      roles: roles.success ? roles.data.map((r) => roleLabel(r.roleKey)) : [],
      state: expired ? "EXPIRED" : invitation.status,
    };
  });
}

/**
 * Accepts an invitation for a signed-in user (D-04: links the existing global User, or the one
 * just created). The user's verified email must match the invited email.
 */
export async function acceptInvitation(
  deps: CoreDeps,
  user: { id: string; email: string; emailVerified: boolean },
  token: string,
  request?: { ip?: string | null; userAgent?: string | null },
): Promise<{ tenantId: string }> {
  const found = await findInvitation(deps.db, token);
  if (!found)
    throw new AppError("NOT_FOUND", "This invitation link is not valid.");
  const tenantId = found.tenant_id;
  const now = nowOf(deps);

  await withTenant(
    deps.db,
    tenantId,
    async (tx) => {
      const invitation = await tx.invitation.findUnique({
        where: { id: found.id },
      });
      if (!invitation || invitation.status !== "PENDING") {
        throw new AppError(
          "CONFLICT",
          "This invitation has already been used or was cancelled.",
        );
      }
      if (invitation.expiresAt <= now) {
        throw new AppError(
          "CONFLICT",
          "This invitation has expired. Ask for a new one.",
        );
      }
      if (invitation.email !== user.email.toLowerCase()) {
        throw new AppError(
          "FORBIDDEN",
          `This invitation was sent to ${invitation.email}. Sign in with that email to accept it.`,
        );
      }
      if (!user.emailVerified) {
        throw new AppError("FORBIDDEN", "Verify your email address first.");
      }
      const roles = roleGrantsSchema.parse(invitation.roles);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
      });
      if (tenant.status === "CANCELLED") {
        throw new AppError("CONFLICT", "This gym is no longer active.");
      }

      const existing = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user.id } },
        include: { roles: true },
      });
      const wasActiveStaff =
        existing?.status === "ACTIVE" &&
        hasStaffRole(existing.roles.map((r) => r.roleKey));
      const membership = existing
        ? await tx.tenantMembership.update({
            where: { id: existing.id },
            data: { status: "ACTIVE", deactivatedAt: null },
          })
        : await tx.tenantMembership.create({
            data: { tenantId, userId: user.id },
          });

      const have = new Set(
        (existing?.roles ?? []).map((r) => `${r.roleKey}|${r.branchId ?? "*"}`),
      );
      const toAdd = roles.filter(
        (r) => !have.has(`${r.roleKey}|${r.branchId ?? "*"}`),
      );
      if (toAdd.length) {
        await tx.roleAssignment.createMany({
          data: toAdd.map((r) => ({
            tenantId,
            membershipId: membership.id,
            roleKey: r.roleKey,
            branchId: r.branchId,
          })),
        });
      }
      if (!wasActiveStaff && hasStaffRole(roles.map((r) => r.roleKey))) {
        await bumpUsage(tx, tenantId, "staff.max", 1);
      }
      // Platform-created tenants get their settings row when the owner arrives.
      await tx.tenantSettings.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      });
      // Member app invite (M2): link the account to the member profile.
      if (invitation.memberId) {
        const profile = await tx.memberProfile.findUnique({
          where: { id: invitation.memberId },
        });
        const taken = await tx.memberProfile.findUnique({
          where: { tenantId_userId: { tenantId, userId: user.id } },
        });
        if (!profile || profile.status === "ARCHIVED") {
          throw new AppError(
            "CONFLICT",
            "This member record is no longer active. Ask the gym for a new invite.",
          );
        }
        if (taken && taken.id !== profile.id) {
          throw new AppError(
            "CONFLICT",
            "Your account is already linked to another member record at this gym.",
          );
        }
        if (!profile.userId) {
          await tx.memberProfile.update({
            where: { id: profile.id },
            data: { userId: user.id },
          });
        }
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: now, acceptedUserId: user.id },
      });
      await recordAudit(
        tx,
        { userId: user.id, tenantId, request },
        {
          action: "staff.invitation_accepted",
          entityType: "Invitation",
          entityId: invitation.id,
          after: { roles },
        },
      );
    },
    { userId: user.id },
  );
  return { tenantId };
}

export type StaffRow = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: "ACTIVE" | "DEACTIVATED";
  roles: { roleKey: string; branchId: string | null }[];
  joinedAt: Date;
};

/** Staff visible to this context: all, or those with a role in the viewer's branches. */
export async function listStaff(deps: CoreDeps, ctx: AuthContext) {
  requirePermission(ctx, "staff.view");
  const allowed = allowedBranchIds(ctx, "staff.view");
  return inTenant(deps, ctx, async (tx) => {
    const [memberships, invitations] = await inOrder([
      tx.tenantMembership.findMany({
        include: { roles: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      }),
      tx.invitation.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const visible = (roles: { roleKey: string; branchId: string | null }[]) =>
      allowed === "ALL" ||
      roles.some((r) => r.branchId === null || allowed.includes(r.branchId));

    const staff: StaffRow[] = memberships
      .filter((m) => hasStaffRole(m.roles.map((r) => r.roleKey)))
      .filter((m) => visible(m.roles))
      .map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        status: m.status,
        roles: m.roles.map((r) => ({
          roleKey: r.roleKey,
          branchId: r.branchId,
        })),
        joinedAt: m.createdAt,
      }));
    const pending = invitations
      .map((i) => ({
        ...i,
        roles: roleGrantsSchema.safeParse(i.roles).data ?? [],
      }))
      // Member app invites are listed on the member's profile, not here.
      .filter((i) => hasStaffRole(i.roles.map((r) => r.roleKey)))
      .filter((i) => visible(i.roles))
      .map((i) => ({
        id: i.id,
        email: i.email,
        roles: i.roles,
        expiresAt: i.expiresAt,
        expired: i.expiresAt <= nowOf(deps),
        createdAt: i.createdAt,
      }));
    return { staff, invitations: pending };
  });
}

/**
 * Deactivates or reactivates a staff member's access to this tenant (their global account and
 * other gyms are untouched). The access check on every request then refuses them immediately.
 */
export async function setStaffActive(
  deps: CoreDeps,
  ctx: AuthContext,
  membershipId: string,
  active: boolean,
) {
  const ent = await guard(deps, ctx, {
    permission: "staff.manage",
    write: true,
  });
  return inTenant(deps, ctx, async (tx) => {
    const membership = await tx.tenantMembership.findUnique({
      where: { id: membershipId },
      include: { roles: true },
    });
    if (!membership) throw new AppError("NOT_FOUND", "Staff member not found.");
    if (membership.userId === ctx.userId) {
      throw new AppError("FORBIDDEN", "You can't deactivate yourself.");
    }
    const roleKeys = membership.roles.map((r) => r.roleKey);
    // You may only manage someone whose every role you could have granted.
    assertCanGrantRoles(
      ctx,
      membership.roles
        .filter(
          (r) => isTenantRoleKey(r.roleKey) && TENANT_ROLES[r.roleKey].staff,
        )
        .map((r) => ({ roleKey: r.roleKey, branchId: r.branchId })),
    );
    const target = active ? "ACTIVE" : "DEACTIVATED";
    if (membership.status === target) return membership;

    if (!active && roleKeys.includes("GYM_OWNER")) {
      const owners = await tx.roleAssignment.findMany({
        where: { roleKey: "GYM_OWNER", membership: { status: "ACTIVE" } },
        select: { membershipId: true },
      });
      if (new Set(owners.map((o) => o.membershipId)).size <= 1) {
        throw new AppError(
          "CONFLICT",
          "A gym needs at least one active owner.",
        );
      }
    }
    if (active && hasStaffRole(roleKeys)) {
      await checkQuota(tx, ent, ctx.tenantId, "staff.max", 1);
    }
    const updated = await tx.tenantMembership.update({
      where: { id: membershipId },
      data: { status: target, deactivatedAt: active ? null : nowOf(deps) },
    });
    if (hasStaffRole(roleKeys)) {
      await bumpUsage(tx, ctx.tenantId, "staff.max", active ? 1 : -1);
    }
    await recordAudit(tx, ctx, {
      action: active ? "staff.reactivated" : "staff.deactivated",
      entityType: "TenantMembership",
      entityId: membershipId,
      meta: { userId: membership.userId },
    });
    return updated;
  });
}
