import { withTenant, type TenantTransaction } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  requirePermission,
  type AuthContext,
} from "../authz";
import { num } from "../billing/service";
import { AppError } from "../errors";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { fromDbDate } from "../time/dates";
import { parseInput } from "../validation";
import type { MemberContext } from "./self";
import { memberName } from "./service";

/**
 * Privacy minimum for launch (M4 §7): privacy notice, "download my data", "request deletion".
 * Deletion anonymises personal fields; financial records (invoices, payments, credit notes) are
 * kept as the law requires — see docs/SECURITY.md "Retention".
 */
export const PRIVACY_NOTICE_VERSION = "2026-11-05";

const inMember = <T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) => withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });

export async function getMyPrivacy(deps: CoreDeps, mctx: MemberContext) {
  return inMember(deps, mctx, async (tx) => {
    const m = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    const open = await tx.memberDataRequest.findFirst({
      where: { memberId: m.id, kind: "DELETION", status: "OPEN" },
    });
    return {
      accepted: m.privacyNoticeVersion === PRIVACY_NOTICE_VERSION,
      acceptedAt: m.privacyAcceptedAt,
      version: PRIVACY_NOTICE_VERSION,
      deletionRequestedAt: open?.createdAt ?? null,
    };
  });
}

export async function acceptPrivacyNotice(deps: CoreDeps, mctx: MemberContext) {
  return inMember(deps, mctx, async (tx) => {
    await tx.memberProfile.update({
      where: { id: mctx.memberId },
      data: {
        privacyAcceptedAt: nowOf(deps),
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      },
    });
    await recordAudit(
      tx,
      { tenantId: mctx.tenantId, userId: mctx.userId },
      {
        action: "member.privacy_accepted",
        entityType: "MemberProfile",
        entityId: mctx.memberId,
        meta: { version: PRIVACY_NOTICE_VERSION },
      },
    );
  });
}

/** Everything the gym holds about the member, as JSON (health data arrives in M7). */
export async function exportMyData(deps: CoreDeps, mctx: MemberContext) {
  return inMember(deps, mctx, async (tx) => {
    const id = mctx.memberId;
    const m = await tx.memberProfile.findUniqueOrThrow({ where: { id } });
    const [memberships, invoices, payments, consents, attendance, bookings] = [
      await tx.membership.findMany({
        where: { memberId: id },
        include: { plan: { select: { name: true } } },
      }),
      await tx.gymInvoice.findMany({
        where: { memberId: id },
        select: {
          number: true,
          issueDate: true,
          totalMinor: true,
          status: true,
        },
      }),
      await tx.gymPayment.findMany({
        where: { memberId: id },
        select: {
          receiptNumber: true,
          receivedAt: true,
          amountMinor: true,
          method: true,
          status: true,
        },
      }),
      await tx.contactConsent.findMany({
        where: { memberId: id },
        select: {
          channel: true,
          purpose: true,
          status: true,
          capturedAt: true,
        },
      }),
      await tx.attendanceEvent.findMany({
        where: { memberId: id, result: "ACCEPTED" },
        select: { occurredAt: true, type: true, method: true },
      }),
      await tx.booking.findMany({
        where: { memberId: id },
        include: { session: { select: { name: true, startsAt: true } } },
      }),
    ];
    // M7: their own health and fitness data is theirs to take (staff exports never include it).
    const fitness = {
      healthConsent: await tx.healthDataConsent.findMany({
        where: { memberId: id },
        select: { status: true, version: true, capturedAt: true },
      }),
      workouts: await tx.workoutLog.findMany({
        where: { memberId: id },
        include: {
          sets: { include: { exercise: { select: { name: true } } } },
        },
      }),
      personalRecords: await tx.personalRecord.findMany({
        where: { memberId: id },
        include: { exercise: { select: { name: true } } },
      }),
      assessments: await tx.fitnessAssessment.findMany({
        where: { memberId: id },
        select: { assessedOn: true, metrics: true, notes: true },
      }),
      goals: await tx.memberGoal.findMany({ where: { memberId: id } }),
      foodLogs: await tx.foodLog.findMany({ where: { memberId: id } }),
      waterLogs: await tx.waterLog.findMany({
        where: { memberId: id },
        select: { loggedOn: true, ml: true },
      }),
      trainerFeedback: await tx.trainerFeedback.findMany({
        where: { memberId: id },
        select: { body: true, createdAt: true },
      }),
    };
    await tx.memberDataRequest.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: id,
        kind: "EXPORT",
        status: "DONE",
        handledAt: nowOf(deps),
        note: "Downloaded in the member app",
      },
    });
    await recordAudit(
      tx,
      { tenantId: mctx.tenantId, userId: mctx.userId },
      {
        action: "member.data_exported",
        entityType: "MemberProfile",
        entityId: id,
      },
    );
    return {
      exportedAt: nowOf(deps).toISOString(),
      gym: mctx.tenantName,
      profile: {
        memberCode: m.memberCode,
        name: memberName(m),
        email: m.email,
        phone: m.phone,
        dateOfBirth: m.dateOfBirth ? fromDbDate(m.dateOfBirth) : null,
        gender: m.gender,
        address:
          [m.addressLine1, m.city, m.postalCode].filter(Boolean).join(", ") ||
          null,
        emergencyContact:
          [m.emergencyName, m.emergencyPhone].filter(Boolean).join(" ") || null,
        joinedAt: m.joinedAt,
      },
      memberships: memberships.map((x) => ({
        plan: x.plan.name,
        status: x.status,
        start: fromDbDate(x.startDate),
        end: fromDbDate(x.endDate),
      })),
      invoices: invoices.map((x) => ({
        number: x.number,
        date: fromDbDate(x.issueDate),
        totalPaise: num(x.totalMinor),
        status: x.status,
      })),
      payments: payments.map((x) => ({
        receipt: x.receiptNumber,
        at: x.receivedAt,
        amountPaise: num(x.amountMinor),
        method: x.method,
        status: x.status,
      })),
      consents,
      checkIns: attendance,
      classBookings: bookings.map((b) => ({
        class: b.session.name,
        at: b.session.startsAt,
        status: b.status,
      })),
      fitness,
    };
  });
}

/** Member asks for deletion: a request staff handle (not instant: dues, legal records). */
export async function requestMyDeletion(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { note } = parseInput(
    z.object({ note: z.string().trim().max(500).optional() }),
    raw,
  );
  return inMember(deps, mctx, async (tx) => {
    const open = await tx.memberDataRequest.findFirst({
      where: { memberId: mctx.memberId, kind: "DELETION", status: "OPEN" },
    });
    if (open) return open;
    const req = await tx.memberDataRequest.create({
      data: {
        tenantId: mctx.tenantId,
        memberId: mctx.memberId,
        kind: "DELETION",
        note: note || null,
      },
    });
    await recordAudit(
      tx,
      { tenantId: mctx.tenantId, userId: mctx.userId },
      {
        action: "member.deletion_requested",
        entityType: "MemberDataRequest",
        entityId: req.id,
      },
    );
    // Tell the owners/administrators (recipient choice only).
    const staff = await tx.roleAssignment.findMany({
      where: {
        roleKey: { in: ["GYM_OWNER", "GYM_ADMIN"] },
        membership: { status: "ACTIVE" },
      },
      include: { membership: { select: { userId: true } } },
    });
    const m = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    for (const s of staff)
      await tx.notification.createMany({
        data: [
          {
            tenantId: mctx.tenantId,
            userId: s.membership.userId,
            channel: "IN_APP",
            category: "SERVICE",
            templateKey: "member.data_request",
            title: `${memberName(m)} asked to delete their data`,
            body: "Handle it on Members → Privacy requests.",
            link: "/members/privacy",
            status: "SENT",
            sentAt: new Date(),
            dedupeKey: `datareq:${req.id}:${s.membership.userId}`,
          },
        ],
        skipDuplicates: true,
      });
    return req;
  });
}

export async function listDataRequests(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "members.view" });
  const allowed = allowedBranchIds(ctx, "members.view");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.memberDataRequest.findMany({
      where:
        allowed === "ALL" ? {} : { member: { homeBranchId: { in: allowed } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            anonymizedAt: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      ...r,
      member: { ...r.member, name: memberName(r.member) },
    }));
  });
}

/**
 * Staff carry out a deletion: personal fields wiped, app access removed, pass revoked, future
 * bookings cancelled. Invoices/payments stay (legal retention); their snapshots are unchanged.
 */
export async function completeDeletion(
  deps: CoreDeps,
  ctx: AuthContext,
  requestId: string,
) {
  await guard(deps, ctx, { permission: "members.delete", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const req = await tx.memberDataRequest.findUnique({
      where: { id: requestId },
      include: { member: true },
    });
    if (!req || req.kind !== "DELETION")
      throw new AppError("NOT_FOUND", "Request not found.");
    requirePermission(ctx, "members.delete", {
      branchId: req.member.homeBranchId,
    });
    if (req.status !== "OPEN")
      throw new AppError("CONFLICT", "This request has been handled.");
    const memberId = req.memberId;
    const userId = req.member.userId;
    await tx.memberProfile.update({
      where: { id: memberId },
      data: {
        firstName: "Deleted",
        lastName: "member",
        email: null,
        phone: null,
        dateOfBirth: null,
        gender: null,
        addressLine1: null,
        city: null,
        postalCode: null,
        stateCode: null,
        emergencyName: null,
        emergencyPhone: null,
        photoFileId: null,
        tags: [],
        userId: null,
        status: "ARCHIVED",
        archivedAt: now,
        anonymizedAt: now,
      },
    });
    // Staff notes may hold personal details; they go too.
    await tx.memberNote.deleteMany({ where: { memberId } });
    // M7: health and fitness data (workouts, measurements, goals, food/water, feedback) is erased.
    await tx.$executeRaw`SELECT app.erase_member_health_data(${memberId}::uuid)`;
    await tx.memberPass.updateMany({
      where: { memberId, status: "ACTIVE" },
      data: {
        status: "REVOKED",
        revokedAt: now,
        revokedById: ctx.userId,
        revokedReason: "Member deleted",
      },
    });
    const future = await tx.booking.findMany({
      where: { memberId, status: "BOOKED", session: { startsAt: { gt: now } } },
      select: { id: true, sessionId: true },
    });
    for (const b of future) {
      await tx.booking.update({
        where: { id: b.id },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelReason: "Member deleted",
        },
      });
      await tx.$executeRaw`UPDATE app.class_session SET booked_count = booked_count - 1 WHERE id = ${b.sessionId}::uuid AND booked_count > 0`;
    }
    await tx.waitlistEntry.updateMany({
      where: { memberId, status: "WAITING" },
      data: { status: "LEFT", note: "Member deleted" },
    });
    if (userId) {
      // App access to this gym ends; their global account and other gyms are untouched.
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        include: { roles: true },
      });
      if (membership) {
        await tx.roleAssignment.deleteMany({
          where: { membershipId: membership.id, roleKey: "MEMBER" },
        });
        if (membership.roles.every((r) => r.roleKey === "MEMBER"))
          await tx.tenantMembership.update({
            where: { id: membership.id },
            data: { status: "DEACTIVATED", deactivatedAt: now },
          });
      }
    }
    await tx.memberDataRequest.update({
      where: { id: req.id },
      data: { status: "DONE", handledById: ctx.userId, handledAt: now },
    });
    await recordAudit(tx, ctx, {
      action: "member.anonymised",
      entityType: "MemberProfile",
      entityId: memberId,
      branchId: req.member.homeBranchId,
      meta: { requestId: req.id, futureBookingsCancelled: future.length },
    });
  });
}

export async function rejectDataRequest(
  deps: CoreDeps,
  ctx: AuthContext,
  requestId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.delete", write: true });
  const { note } = parseInput(
    z.object({ note: z.string().trim().min(3, "Say why.").max(500) }),
    raw,
  );
  return inTenant(deps, ctx, async (tx) => {
    const req = await tx.memberDataRequest.findUnique({
      where: { id: requestId },
      include: { member: true },
    });
    if (!req) throw new AppError("NOT_FOUND", "Request not found.");
    requirePermission(ctx, "members.delete", {
      branchId: req.member.homeBranchId,
    });
    if (req.status !== "OPEN")
      throw new AppError("CONFLICT", "This request has been handled.");
    await tx.memberDataRequest.update({
      where: { id: req.id },
      data: {
        status: "REJECTED",
        handledById: ctx.userId,
        handledAt: nowOf(deps),
        note,
      },
    });
    await recordAudit(tx, ctx, {
      action: "member.deletion_rejected",
      entityType: "MemberDataRequest",
      entityId: req.id,
      meta: { note },
    });
  });
}
