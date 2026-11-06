import { inOrder, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { hasPermission, requirePermission, type AuthContext } from "../authz";
import { AppError } from "../errors";
import { memberName } from "../members/service";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { fromDbDate, todayIn } from "../time/dates";
import { parseInput } from "../validation";

/** The trainer profile of the caller, or null. */
export async function trainerOf(tx: TenantTransaction, ctx: AuthContext) {
  return tx.trainerProfile.findUnique({
    where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
  });
}

/** Is `memberId` currently assigned to the caller (as trainer)? */
export async function isMyClient(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
): Promise<boolean> {
  const trainer = await trainerOf(tx, ctx);
  if (!trainer) return false;
  const row = await tx.trainerClientAssignment.findFirst({
    where: { trainerId: trainer.id, memberId, endedAt: null },
    select: { id: true },
  });
  return row !== null;
}

const assignSchema = z.object({
  memberId: z.uuid("Pick a member."),
  trainerId: z.uuid("Pick a trainer."),
  note: z.string().trim().max(300).optional(),
});

/** Assigns a trainer to a member (history is kept; re-assigning the same pair is refused). */
export async function assignTrainer(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(assignSchema, raw);
  await guard(deps, ctx, { permission: "trainers.assign", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const [member, trainer] = await inOrder([
      tx.memberProfile.findUnique({ where: { id: input.memberId } }),
      tx.trainerProfile.findUnique({ where: { id: input.trainerId } }),
    ]);
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    if (!trainer || trainer.status !== "ACTIVE")
      throw new AppError("VALIDATION_FAILED", "Pick an active trainer.", {
        fields: { trainerId: ["Pick an active trainer."] },
      });
    requirePermission(ctx, "trainers.assign", {
      branchId: member.homeBranchId,
    });
    const existing = await tx.trainerClientAssignment.findFirst({
      where: { trainerId: trainer.id, memberId: member.id, endedAt: null },
    });
    if (existing)
      throw new AppError("CONFLICT", "This trainer is already assigned.");
    const row = await tx.trainerClientAssignment.create({
      data: {
        tenantId: ctx.tenantId,
        trainerId: trainer.id,
        memberId: member.id,
        note: input.note || null,
        startedAt: now,
        assignedById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "trainer.client_assigned",
      entityType: "TrainerClientAssignment",
      entityId: row.id,
      branchId: member.homeBranchId,
      meta: { trainer: trainer.displayName, memberId: member.id },
    });
    return row;
  });
}

const endSchema = z.object({
  reason: z.string().trim().min(2, "Say why.").max(300),
});

export async function endTrainerAssignment(
  deps: CoreDeps,
  ctx: AuthContext,
  assignmentId: string,
  raw: unknown,
) {
  const { reason } = parseInput(endSchema, raw);
  await guard(deps, ctx, { permission: "trainers.assign", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const row = await tx.trainerClientAssignment.findUnique({
      where: { id: assignmentId },
      include: { member: true },
    });
    if (!row) throw new AppError("NOT_FOUND", "Assignment not found.");
    requirePermission(ctx, "trainers.assign", {
      branchId: row.member.homeBranchId,
    });
    if (row.endedAt) throw new AppError("CONFLICT", "Already ended.");
    await tx.trainerClientAssignment.update({
      where: { id: row.id },
      data: { endedAt: now, endedById: ctx.userId, endReason: reason },
    });
    await recordAudit(tx, ctx, {
      action: "trainer.client_unassigned",
      entityType: "TrainerClientAssignment",
      entityId: row.id,
      branchId: row.member.homeBranchId,
      meta: { reason },
    });
  });
}

/** Assignment history for a member (staff member page). */
export async function memberTrainers(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "members.view" });
  return inTenant(deps, ctx, async (tx) => {
    const member = await tx.memberProfile.findUnique({
      where: { id: memberId },
    });
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    requirePermission(ctx, "members.view", { branchId: member.homeBranchId });
    const rows = await tx.trainerClientAssignment.findMany({
      where: { memberId },
      orderBy: { startedAt: "desc" },
      include: { trainer: { select: { id: true, displayName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      trainer: r.trainer,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      endReason: r.endReason,
      note: r.note,
      current: r.endedAt === null,
    }));
  });
}

/**
 * The trainer's own clients (clients.view). Only what a trainer needs: name, contact, the
 * current membership and PT sessions left — never invoices or payments (spec §6).
 */
export async function listMyClients(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "clients.view" });
  const today = todayIn(ctx.timezone, nowOf(deps));
  return inTenant(deps, ctx, async (tx) => {
    const trainer = await trainerOf(tx, ctx);
    if (!trainer) return { trainer: null, clients: [] };
    const rows = await tx.trainerClientAssignment.findMany({
      where: { trainerId: trainer.id, endedAt: null },
      orderBy: { startedAt: "asc" },
      include: {
        member: {
          include: {
            memberships: {
              where: { status: { in: ["ACTIVE", "PAUSED"] } },
              include: { plan: { select: { name: true } } },
              orderBy: { endDate: "desc" },
              take: 1,
            },
            ptBalances: {
              where: { status: "ACTIVE" },
              select: { id: true, name: true, expiresOn: true },
            },
          },
        },
      },
    });
    const clients = [];
    for (const r of rows) {
      const m = r.member;
      const sessionsLeft: {
        id: string;
        name: string;
        left: number;
        expiresOn: string | null;
      }[] = [];
      for (const b of m.ptBalances) {
        const sum = await tx.entitlementLedger.aggregate({
          where: { ptBalanceId: b.id },
          _sum: { delta: true },
        });
        sessionsLeft.push({
          id: b.id,
          name: b.name,
          left: sum._sum.delta ?? 0,
          expiresOn: b.expiresOn ? fromDbDate(b.expiresOn) : null,
        });
      }
      const current = m.memberships[0];
      clients.push({
        memberId: m.id,
        name: memberName(m),
        memberCode: m.memberCode,
        phone: m.phone,
        since: r.startedAt,
        membership: current
          ? {
              plan: current.plan.name,
              status: current.status,
              endDate: fromDbDate(current.endDate),
              daysLeft: Math.max(
                Math.round(
                  (current.endDate.getTime() -
                    new Date(`${today}T00:00:00Z`).getTime()) /
                    86_400_000,
                ),
                0,
              ),
            }
          : null,
        pt: sessionsLeft,
      });
    }
    return {
      trainer: { id: trainer.id, displayName: trainer.displayName },
      clients,
    };
  });
}

/** May the caller see this member as a trainer (assigned) or as general staff (members.view)? */
export async function canViewClient(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
  homeBranchId: string,
): Promise<boolean> {
  if (hasPermission(ctx, "members.view", { branchId: homeBranchId }))
    return true;
  // The assignment itself grants access, whichever branch the member's home is.
  if (!hasPermission(ctx, "clients.view")) return false;
  return isMyClient(tx, ctx, memberId);
}
