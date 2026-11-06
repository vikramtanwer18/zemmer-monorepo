import { withTenant, type TenantTransaction } from "@gym/db";
import { emitEvent } from "../events";
import { z } from "zod";
import { loadAccessMemberships } from "../attendance/service";
import { evaluateAccess, rejectMessage } from "../attendance/rules";
import { recordAudit, type AuditActor } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { classCreditBalance, lockMembership } from "../credits/ledger";
import { AppError } from "../errors";
import type { MemberContext } from "../members/self";
import { memberName } from "../members/service";
import { notify } from "../notifications";
import { isFeatureEnabled } from "../entitlements";
import {
  entitlementsFor,
  guard,
  inTenant,
  nowOf,
  type CoreDeps,
} from "../tenancy/deps";
import {
  addDays,
  formatClock,
  localMinuteOf,
  startOfDayUtc,
  todayIn,
} from "../time/dates";
import { parseInput } from "../validation";
import {
  bookingOpensAt,
  bookingWindow,
  cancelCutoffAt,
  isLateCancel,
  promotionOrder,
} from "./rules";

/**
 * Bookings (M3 §4). Concurrency design:
 * - A seat is taken with one conditional UPDATE (`booked_count < capacity`), which row-locks the
 *   session; a CHECK constraint makes overbooking impossible even for a buggy caller.
 * - Every path that changes a session's seats takes that session row lock first, then the
 *   member's membership row (credits) — always in that order, so they can't deadlock.
 * - Cancellation, promotion from the waitlist and the credit movements share one transaction.
 */

type Actor = AuditActor & { userId: string | null };

type BookingActor = {
  tenantId: string;
  /** Staff user or the member's own account. */
  userId: string;
  audit: AuditActor;
  source: "MEMBER_APP" | "STAFF";
};

async function lockSession(tx: TenantTransaction, sessionId: string) {
  await tx.$queryRaw`SELECT id FROM app.class_session WHERE id = ${sessionId}::uuid FOR UPDATE`;
  const session = await tx.classSession.findUnique({
    where: { id: sessionId },
    include: { branch: true },
  });
  if (!session) throw new AppError("NOT_FOUND", "Class not found.");
  return session;
}

type SessionRow = Awaited<ReturnType<typeof lockSession>>;

function sessionTz(session: SessionRow, fallback: string) {
  return session.branch.timezone ?? fallback;
}

/** The membership that lets this member into this class, plus its credit rule. */
async function eligibleMembership(
  tx: TenantTransaction,
  member: { id: string; status: string; homeBranchId: string },
  session: SessionRow,
  timezone: string,
) {
  if (member.status !== "ACTIVE")
    throw new AppError("CONFLICT", rejectMessage("MEMBER_INACTIVE"));
  const all = await loadAccessMemberships(tx, member.id);
  // A plan with 0 class credits doesn't include classes (M2: null = unlimited, 0 = none).
  const memberships = all.filter((m) => m.classCredits !== 0);
  if (memberships.length === 0 && all.some((m) => m.status === "ACTIVE"))
    throw new AppError("CONFLICT", "Your membership doesn't include classes.", {
      details: { code: "NO_CLASSES" },
    });
  const access = evaluateAccess(memberships, {
    branchId: session.branchId,
    homeBranchId: member.homeBranchId,
    today: todayIn(timezone, session.startsAt),
    planCodes: session.eligiblePlanCodes,
  });
  if (!access.ok) {
    const message =
      access.code === "NO_MEMBERSHIP" && session.eligiblePlanCodes.length
        ? "This class is only for members on certain plans."
        : rejectMessage(access.code, access.detail);
    throw new AppError("CONFLICT", message, { details: { code: access.code } });
  }
  return {
    membershipId: access.membership.id,
    credits: access.membership.classCredits ?? null,
  };
}

/** Spends one credit when the plan uses credits. Call with the session lock already held. */
async function spendCredit(
  tx: TenantTransaction,
  tenantId: string,
  memberId: string,
  eligible: { membershipId: string; credits: number | null },
) {
  if (eligible.credits === null) return false;
  await lockMembership(tx, eligible.membershipId);
  const balance = await classCreditBalance(
    tx,
    tenantId,
    { id: eligible.membershipId, memberId },
    eligible.credits,
  );
  if (balance < 1)
    throw new AppError(
      "CONFLICT",
      "No class credits left on this membership.",
      { details: { code: "NO_CREDITS" } },
    );
  return true;
}

/** Takes a seat: true if one was free. The only place booked_count goes up. */
async function takeSeat(tx: TenantTransaction, sessionId: string) {
  const updated = await tx.$executeRaw`
    UPDATE app.class_session SET booked_count = booked_count + 1, updated_at = now()
     WHERE id = ${sessionId}::uuid AND status = 'SCHEDULED' AND booked_count < capacity`;
  return updated === 1;
}

async function createBookingTx(
  tx: TenantTransaction,
  actor: BookingActor,
  session: SessionRow,
  memberId: string,
  eligible: { membershipId: string; credits: number | null },
  source: "MEMBER_APP" | "STAFF" | "WAITLIST",
) {
  const usedCredit = await spendCredit(tx, actor.tenantId, memberId, eligible);
  const booking = await tx.booking.create({
    data: {
      tenantId: actor.tenantId,
      sessionId: session.id,
      memberId,
      membershipId: eligible.membershipId,
      status: "BOOKED",
      source,
      usedCredit,
      bookedById: actor.userId,
    },
  });
  if (usedCredit)
    await tx.entitlementLedger.create({
      data: {
        tenantId: actor.tenantId,
        memberId,
        kind: "CLASS_CREDIT",
        membershipId: eligible.membershipId,
        delta: -1,
        reason: "BOOKING",
        bookingId: booking.id,
        createdById: actor.userId,
      },
    });
  return booking;
}

async function bookTx(
  tx: TenantTransaction,
  actor: BookingActor,
  input: { sessionId: string; memberId: string },
  now: Date,
  fallbackTz: string,
) {
  // Lock order: session first (the conditional UPDATE below would take it anyway).
  const session = await lockSession(tx, input.sessionId);
  if (session.status !== "SCHEDULED")
    throw new AppError("CONFLICT", "This class isn't open for booking.");
  const window = bookingWindow(session, now);
  if (window === "NOT_OPEN") {
    const opens = bookingOpensAt(session);
    const tz = sessionTz(session, fallbackTz);
    throw new AppError(
      "CONFLICT",
      `Booking opens on ${todayIn(tz, opens)} at ${formatClock(localMinuteOf(opens, tz))}.`,
      { details: { code: "NOT_OPEN", opensAt: opens } },
    );
  }
  if (window === "CLOSED")
    throw new AppError("CONFLICT", "Booking for this class has closed.", {
      details: { code: "CLOSED" },
    });
  const member = await tx.memberProfile.findUnique({
    where: { id: input.memberId },
  });
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  const existing = await tx.booking.findFirst({
    where: {
      sessionId: session.id,
      memberId: member.id,
      status: { not: "CANCELLED" },
    },
  });
  if (existing)
    throw new AppError("CONFLICT", "Already booked for this class.", {
      details: { code: "ALREADY_BOOKED" },
    });
  const eligible = await eligibleMembership(
    tx,
    member,
    session,
    sessionTz(session, fallbackTz),
  );
  if (!(await takeSeat(tx, session.id)))
    throw new AppError("CONFLICT", "This class is full.", {
      details: { code: "CLASS_FULL", waitlist: session.waitlistEnabled },
    });
  const booking = await createBookingTx(
    tx,
    actor,
    session,
    member.id,
    eligible,
    actor.source,
  );
  // Booking directly takes them off the waitlist.
  await tx.waitlistEntry.updateMany({
    where: { sessionId: session.id, memberId: member.id, status: "WAITING" },
    data: { status: "LEFT", note: "Booked directly", bookingId: booking.id },
  });
  await recordAudit(tx, actor.audit, {
    action: "booking.created",
    entityType: "Booking",
    entityId: booking.id,
    branchId: session.branchId,
    meta: {
      sessionId: session.id,
      memberId: member.id,
      source: actor.source,
      usedCredit: booking.usedCredit,
    },
  });
  return booking;
}

/** Moves waiting members into free seats, in position order, until full or the cutoff passed. */
async function promoteFromWaitlist(
  tx: TenantTransaction,
  actor: BookingActor,
  session: SessionRow,
  now: Date,
  fallbackTz: string,
): Promise<string[]> {
  if (isLateCancel(session, now)) return []; // promotion stops at the cancellation cutoff
  const promoted: string[] = [];
  const waiting = promotionOrder(
    await tx.waitlistEntry.findMany({
      where: { sessionId: session.id, status: "WAITING" },
      include: { member: true },
    }),
  );
  const tz = sessionTz(session, fallbackTz);
  for (const entry of waiting) {
    const fresh = await tx.classSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    if (fresh.bookedCount >= fresh.capacity) break;
    let eligible;
    try {
      eligible = await eligibleMembership(tx, entry.member, session, tz);
    } catch (err) {
      await tx.waitlistEntry.update({
        where: { id: entry.id },
        data: {
          status: "SKIPPED",
          note: err instanceof AppError ? err.message : "Not eligible",
        },
      });
      continue;
    }
    // Credit check before taking the seat (a failed savepoint-less statement would abort the tx).
    if (eligible.credits !== null) {
      await lockMembership(tx, eligible.membershipId);
      const balance = await classCreditBalance(
        tx,
        actor.tenantId,
        { id: eligible.membershipId, memberId: entry.memberId },
        eligible.credits,
      );
      if (balance < 1) {
        await tx.waitlistEntry.update({
          where: { id: entry.id },
          data: { status: "SKIPPED", note: "No class credits left" },
        });
        continue;
      }
    }
    if (!(await takeSeat(tx, session.id))) break;
    const booking = await createBookingTx(
      tx,
      actor,
      session,
      entry.memberId,
      eligible,
      "WAITLIST",
    );
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "PROMOTED", bookingId: booking.id },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
    });
    await notify(tx, actor.tenantId, {
      templateKey: "class.promoted",
      recipient: {
        memberId: entry.memberId,
        userId: entry.member.userId,
        email: entry.member.email,
      },
      data: {
        name: entry.member.firstName,
        gym: tenant.displayName,
        class: session.name,
        date: todayIn(tz, session.startsAt),
        time: formatClock(localMinuteOf(session.startsAt, tz)),
        cutoff: formatClock(localMinuteOf(cancelCutoffAt(session), tz)),
      },
      link: "/m/classes",
      dedupeKey: `promoted:${booking.id}`,
    });
    await recordAudit(tx, actor.audit, {
      action: "booking.promoted_from_waitlist",
      entityType: "Booking",
      entityId: booking.id,
      branchId: session.branchId,
      meta: {
        sessionId: session.id,
        memberId: entry.memberId,
        position: entry.position,
      },
    });
    promoted.push(booking.id);
  }
  return promoted;
}

async function cancelTx(
  tx: TenantTransaction,
  actor: BookingActor,
  bookingId: string,
  reason: string | null,
  now: Date,
  fallbackTz: string,
  check: (booking: { memberId: string; branchId: string }) => void,
) {
  const peek = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { sessionId: true },
  });
  if (!peek) throw new AppError("NOT_FOUND", "Booking not found.");
  const session = await lockSession(tx, peek.sessionId);
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
  });
  check({ memberId: booking.memberId, branchId: session.branchId });
  if (booking.status !== "BOOKED")
    throw new AppError("CONFLICT", "This booking isn't active.");
  if (session.startsAt.getTime() <= now.getTime())
    throw new AppError("CONFLICT", "The class has already started.");
  const late = isLateCancel(session, now);
  await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: "CANCELLED",
      lateCancel: late,
      cancelledAt: now,
      cancelledById: actor.userId,
      cancelReason: reason,
    },
  });
  await tx.$executeRaw`
    UPDATE app.class_session SET booked_count = booked_count - 1, updated_at = now()
     WHERE id = ${session.id}::uuid AND booked_count > 0`;
  // M6: automation trigger.
  await emitEvent(tx, actor.tenantId, "class.booking_cancelled", {
    bookingId: booking.id,
    memberId: booking.memberId,
    sessionId: session.id,
    branchId: session.branchId,
    late,
  });
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: actor.tenantId },
  });
  const forfeit = late && (settings?.lateCancelForfeitsCredit ?? true);
  let creditReturned = false;
  if (booking.usedCredit && booking.membershipId && !forfeit) {
    await tx.entitlementLedger.create({
      data: {
        tenantId: actor.tenantId,
        memberId: booking.memberId,
        kind: "CLASS_CREDIT",
        membershipId: booking.membershipId,
        delta: 1,
        reason: "BOOKING_RETURNED",
        bookingId: booking.id,
        createdById: actor.userId,
      },
    });
    creditReturned = true;
  }
  const promoted = await promoteFromWaitlist(
    tx,
    actor,
    session,
    now,
    fallbackTz,
  );
  await recordAudit(tx, actor.audit, {
    action: late ? "booking.cancelled_late" : "booking.cancelled",
    entityType: "Booking",
    entityId: booking.id,
    branchId: session.branchId,
    meta: {
      sessionId: session.id,
      memberId: booking.memberId,
      creditReturned,
      promoted: promoted.length,
      reason,
    },
  });
  return { late, creditReturned, promoted: promoted.length };
}

async function joinWaitlistTx(
  tx: TenantTransaction,
  actor: BookingActor,
  input: { sessionId: string; memberId: string },
  now: Date,
  fallbackTz: string,
) {
  const session = await lockSession(tx, input.sessionId);
  if (session.status !== "SCHEDULED" || !session.waitlistEnabled)
    throw new AppError("CONFLICT", "This class has no waitlist.");
  if (bookingWindow(session, now) !== "OPEN")
    throw new AppError("CONFLICT", "Booking for this class isn't open.");
  if (session.bookedCount < session.capacity)
    throw new AppError("CONFLICT", "There are free places: book instead.", {
      details: { code: "SEATS_FREE" },
    });
  const member = await tx.memberProfile.findUnique({
    where: { id: input.memberId },
  });
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  const booked = await tx.booking.findFirst({
    where: {
      sessionId: session.id,
      memberId: member.id,
      status: { not: "CANCELLED" },
    },
  });
  const waiting = await tx.waitlistEntry.findFirst({
    where: { sessionId: session.id, memberId: member.id, status: "WAITING" },
  });
  if (booked) throw new AppError("CONFLICT", "Already booked for this class.");
  if (waiting)
    throw new AppError("CONFLICT", "Already on the waitlist for this class.");
  await eligibleMembership(tx, member, session, sessionTz(session, fallbackTz));
  const stats = await tx.waitlistEntry.aggregate({
    where: { sessionId: session.id },
    _max: { position: true },
  });
  const waitingCount = await tx.waitlistEntry.count({
    where: { sessionId: session.id, status: "WAITING" },
  });
  if (session.waitlistMax && waitingCount >= session.waitlistMax)
    throw new AppError("CONFLICT", "The waitlist is full.");
  const entry = await tx.waitlistEntry.create({
    data: {
      tenantId: actor.tenantId,
      sessionId: session.id,
      memberId: member.id,
      position: (stats._max.position ?? 0) + 1,
      createdById: actor.userId,
    },
  });
  await recordAudit(tx, actor.audit, {
    action: "waitlist.joined",
    entityType: "WaitlistEntry",
    entityId: entry.id,
    branchId: session.branchId,
    meta: {
      sessionId: session.id,
      memberId: member.id,
      position: entry.position,
    },
  });
  return { entry, place: waitingCount + 1 };
}

// --- staff adapters -------------------------------------------------------------------------

const staffBookSchema = z.object({
  sessionId: z.uuid(),
  memberId: z.uuid("Pick a member."),
});

function staffActor(ctx: AuthContext): BookingActor {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    audit: ctx,
    source: "STAFF",
  };
}

async function sessionBranch(
  deps: CoreDeps,
  ctx: AuthContext,
  sessionId: string,
) {
  const s = await inTenant(deps, ctx, (tx) =>
    tx.classSession.findUnique({
      where: { id: sessionId },
      select: { branchId: true },
    }),
  );
  if (!s) throw new AppError("NOT_FOUND", "Class not found.");
  return s.branchId;
}

/** Staff book a member into a class (same rules as the member app). */
export async function bookForMember(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(staffBookSchema, raw);
  await guard(deps, ctx, {
    permission: "bookings.manage",
    write: true,
    entitlement: "classes.enabled",
  });
  requirePermission(ctx, "bookings.manage", {
    branchId: await sessionBranch(deps, ctx, input.sessionId),
  });
  return inTenant(deps, ctx, (tx) =>
    bookTx(tx, staffActor(ctx), input, nowOf(deps), ctx.timezone),
  );
}

export async function addToWaitlistForMember(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(staffBookSchema, raw);
  await guard(deps, ctx, {
    permission: "bookings.manage",
    write: true,
    entitlement: "classes.enabled",
  });
  requirePermission(ctx, "bookings.manage", {
    branchId: await sessionBranch(deps, ctx, input.sessionId),
  });
  return inTenant(deps, ctx, (tx) =>
    joinWaitlistTx(tx, staffActor(ctx), input, nowOf(deps), ctx.timezone),
  );
}

export async function cancelBookingAsStaff(
  deps: CoreDeps,
  ctx: AuthContext,
  bookingId: string,
  reason?: string,
) {
  await guard(deps, ctx, { permission: "bookings.manage", write: true });
  return inTenant(deps, ctx, (tx) =>
    cancelTx(
      tx,
      staffActor(ctx),
      bookingId,
      reason?.trim() || "Cancelled by staff",
      nowOf(deps),
      ctx.timezone,
      ({ branchId }) => requirePermission(ctx, "bookings.manage", { branchId }),
    ),
  );
}

export async function removeFromWaitlist(
  deps: CoreDeps,
  ctx: AuthContext,
  entryId: string,
) {
  await guard(deps, ctx, { permission: "bookings.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const entry = await tx.waitlistEntry.findUnique({
      where: { id: entryId },
      include: { session: true },
    });
    if (!entry) throw new AppError("NOT_FOUND", "Waitlist entry not found.");
    requirePermission(ctx, "bookings.manage", {
      branchId: entry.session.branchId,
    });
    if (entry.status !== "WAITING")
      throw new AppError("CONFLICT", "Not waiting any more.");
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "LEFT", note: "Removed by staff" },
    });
    await recordAudit(tx, ctx, {
      action: "waitlist.removed",
      entityType: "WaitlistEntry",
      entityId: entry.id,
      branchId: entry.session.branchId,
    });
  });
}

const markSchema = z.object({
  status: z.enum(["ATTENDED", "NO_SHOW"]),
});

/** Trainer/staff mark attendance (from 30 minutes before the start). */
export async function markBookingAttendance(
  deps: CoreDeps,
  ctx: AuthContext,
  bookingId: string,
  raw: unknown,
) {
  const { status } = parseInput(markSchema, raw);
  await guard(deps, ctx, { permission: "classes.attendance", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        session: { include: { trainer: { select: { userId: true } } } },
      },
    });
    if (!booking) throw new AppError("NOT_FOUND", "Booking not found.");
    // The class's own trainer may mark it wherever it is; others need the branch.
    if (booking.session.trainer?.userId !== ctx.userId)
      requirePermission(ctx, "classes.attendance", {
        branchId: booking.session.branchId,
      });
    if (booking.status === "CANCELLED")
      throw new AppError("CONFLICT", "This booking was cancelled.");
    if (booking.session.startsAt.getTime() - 30 * 60_000 > now.getTime())
      throw new AppError(
        "CONFLICT",
        "Attendance can be marked from 30 minutes before the class.",
      );
    if (booking.status === status) return booking;
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: { status, markedAt: now, markedById: ctx.userId },
    });
    await recordAudit(tx, ctx, {
      action: "booking.marked",
      entityType: "Booking",
      entityId: booking.id,
      branchId: booking.session.branchId,
      before: { status: booking.status },
      after: { status },
    });
    return updated;
  });
}

// --- member app adapters --------------------------------------------------------------------

function memberActor(mctx: MemberContext): BookingActor {
  return {
    tenantId: mctx.tenantId,
    userId: mctx.userId,
    audit: { tenantId: mctx.tenantId, userId: mctx.userId },
    source: "MEMBER_APP",
  };
}

const inMember = <T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) => withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });

async function requireClassesEnabled(deps: CoreDeps, mctx: MemberContext) {
  const ent = await entitlementsFor(deps, mctx.tenantId);
  if (!isFeatureEnabled(ent, "classes.enabled"))
    throw new AppError(
      "ENTITLEMENT_REQUIRED",
      "This gym doesn't take class bookings in the app.",
    );
}

const sessionIdSchema = z.object({ sessionId: z.uuid() });

export async function bookMyClass(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { sessionId } = parseInput(sessionIdSchema, raw);
  await requireClassesEnabled(deps, mctx);
  return inMember(deps, mctx, (tx) =>
    bookTx(
      tx,
      memberActor(mctx),
      { sessionId, memberId: mctx.memberId },
      nowOf(deps),
      mctx.timezone,
    ),
  );
}

export async function joinMyWaitlist(
  deps: CoreDeps,
  mctx: MemberContext,
  raw: unknown,
) {
  const { sessionId } = parseInput(sessionIdSchema, raw);
  await requireClassesEnabled(deps, mctx);
  return inMember(deps, mctx, (tx) =>
    joinWaitlistTx(
      tx,
      memberActor(mctx),
      { sessionId, memberId: mctx.memberId },
      nowOf(deps),
      mctx.timezone,
    ),
  );
}

export async function cancelMyBooking(
  deps: CoreDeps,
  mctx: MemberContext,
  bookingId: string,
) {
  return inMember(deps, mctx, (tx) =>
    cancelTx(
      tx,
      memberActor(mctx),
      bookingId,
      "Cancelled in the member app",
      nowOf(deps),
      mctx.timezone,
      ({ memberId }) => {
        // Another member's booking looks the same as a missing one.
        if (memberId !== mctx.memberId)
          throw new AppError("NOT_FOUND", "Booking not found.");
      },
    ),
  );
}

export async function leaveMyWaitlist(
  deps: CoreDeps,
  mctx: MemberContext,
  entryId: string,
) {
  return inMember(deps, mctx, async (tx) => {
    const entry = await tx.waitlistEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.memberId !== mctx.memberId)
      throw new AppError("NOT_FOUND", "Waitlist entry not found.");
    if (entry.status !== "WAITING")
      throw new AppError("CONFLICT", "Not waiting any more.");
    await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "LEFT", note: "Left in the member app" },
    });
  });
}

/**
 * The member's class schedule: upcoming sessions at branches their memberships reach, with
 * their own booking/waitlist state. Only sessions whose booking window has opened are bookable.
 */
export async function listMyClasses(
  deps: CoreDeps,
  mctx: MemberContext,
  options: { from?: string; days?: number } = {},
) {
  const now = nowOf(deps);
  const from = options.from ?? todayIn(mctx.timezone, now);
  const days = Math.min(Math.max(options.days ?? 7, 1), 14);
  return inMember(deps, mctx, async (tx) => {
    const member = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    const memberships = await loadAccessMemberships(tx, member.id);
    const branchScope = memberships.some(
      (m) => m.accessScope === "ALL_BRANCHES",
    )
      ? undefined
      : [
          member.homeBranchId,
          ...memberships.flatMap((m) =>
            m.accessScope === "LISTED_BRANCHES" ? m.planBranchIds : [],
          ),
        ];
    const sessions = await tx.classSession.findMany({
      where: {
        status: { in: ["SCHEDULED", "CANCELLED"] },
        startsAt: {
          gte: new Date(
            Math.max(
              now.getTime(),
              startOfDayUtc(from, mctx.timezone).getTime(),
            ),
          ),
          lt: startOfDayUtc(addDays(from, days), mctx.timezone),
        },
        ...(branchScope ? { branchId: { in: branchScope } } : {}),
      },
      orderBy: { startsAt: "asc" },
      take: 200,
      include: {
        branch: { select: { name: true, timezone: true } },
        trainer: { select: { displayName: true, visibleToMembers: true } },
        category: { select: { name: true, color: true } },
        bookings: {
          where: { memberId: member.id, status: { not: "CANCELLED" } },
          select: { id: true, status: true },
        },
        waitlist: {
          where: { memberId: member.id, status: "WAITING" },
          select: { id: true, position: true },
        },
      },
    });
    return sessions
      .filter((s) => s.status === "SCHEDULED" || s.bookings.length > 0)
      .map((s) => {
        const tz = s.branch.timezone ?? mctx.timezone;
        const mine = s.bookings[0] ?? null;
        const waiting = s.waitlist[0] ?? null;
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          date: todayIn(tz, s.startsAt),
          startTime: formatClock(localMinuteOf(s.startsAt, tz)),
          endTime: formatClock(localMinuteOf(s.endsAt, tz)),
          branch: s.branch.name,
          trainer: s.trainer?.visibleToMembers ? s.trainer.displayName : null,
          category: s.category,
          spotsLeft: Math.max(s.capacity - s.bookedCount, 0),
          capacity: s.capacity,
          window: bookingWindow(s, now),
          opensAt: bookingOpensAt(s),
          cancelCutoffAt: cancelCutoffAt(s),
          waitlistEnabled: s.waitlistEnabled,
          booking: mine,
          waitlist: waiting,
        };
      });
  });
}

/** The member's own bookings (upcoming and recent). */
export async function listMyBookings(deps: CoreDeps, mctx: MemberContext) {
  const now = nowOf(deps);
  return inMember(deps, mctx, async (tx) => {
    const rows = await tx.booking.findMany({
      where: {
        memberId: mctx.memberId,
        session: {
          startsAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
        },
      },
      orderBy: { session: { startsAt: "desc" } },
      take: 50,
      include: { session: { include: { branch: true } } },
    });
    return rows.map((b) => {
      const tz = b.session.branch.timezone ?? mctx.timezone;
      return {
        id: b.id,
        status: b.status,
        lateCancel: b.lateCancel,
        class: b.session.name,
        sessionStatus: b.session.status,
        date: todayIn(tz, b.session.startsAt),
        startTime: formatClock(localMinuteOf(b.session.startsAt, tz)),
        upcoming: b.session.startsAt.getTime() > now.getTime(),
      };
    });
  });
}

// --- worker jobs ----------------------------------------------------------------------------

/**
 * End of class: sessions that have ended become COMPLETED; bookings still BOOKED become NO_SHOW
 * (their credit stays used); waiting entries expire. Idempotent.
 */
export async function closeEndedSessions(
  tx: TenantTransaction,
  tenantId: string,
  now: Date,
) {
  const ended = await tx.classSession.findMany({
    where: { status: "SCHEDULED", endsAt: { lte: now } },
    select: { id: true, branchId: true },
    take: 500,
  });
  let noShows = 0;
  for (const s of ended) {
    const result = await tx.booking.updateMany({
      where: { sessionId: s.id, status: "BOOKED" },
      data: { status: "NO_SHOW", markedAt: now },
    });
    noShows += result.count;
    await tx.waitlistEntry.updateMany({
      where: { sessionId: s.id, status: "WAITING" },
      data: { status: "EXPIRED", note: "The class took place" },
    });
    await tx.classSession.update({
      where: { id: s.id },
      data: { status: "COMPLETED", completedAt: now },
    });
  }
  if (ended.length)
    await recordAudit(
      tx,
      { system: true, tenantId },
      {
        action: "class_sessions.closed",
        entityType: "ClassSession",
        meta: { sessions: ended.length, noShows },
      },
    );
  return { sessions: ended.length, noShows };
}

/** Reminders N hours before each booked class (in-app + email), once per booking. */
export async function sendClassReminders(
  tx: TenantTransaction,
  tenantId: string,
  now: Date,
) {
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId } });
  const hours = settings?.bookingReminderHours ?? 2;
  if (hours <= 0) return { reminded: 0 };
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const bookings = await tx.booking.findMany({
    where: {
      status: "BOOKED",
      reminderSentAt: null,
      session: {
        status: "SCHEDULED",
        startsAt: { gt: now, lte: new Date(now.getTime() + hours * 3_600_000) },
      },
    },
    include: { member: true, session: { include: { branch: true } } },
    take: 500,
  });
  for (const b of bookings) {
    const tz = b.session.branch.timezone ?? tenant.timezone;
    await notify(tx, tenantId, {
      templateKey: "class.reminder",
      recipient: {
        memberId: b.memberId,
        userId: b.member.userId,
        email: b.member.email,
      },
      data: {
        name: b.member.firstName,
        gym: tenant.displayName,
        class: b.session.name,
        date: todayIn(tz, b.session.startsAt),
        time: formatClock(localMinuteOf(b.session.startsAt, tz)),
        branch: b.session.branch.name,
        cutoff: formatClock(localMinuteOf(cancelCutoffAt(b.session), tz)),
      },
      link: "/m/classes",
      dedupeKey: `class-reminder:${b.id}`,
    });
    await tx.booking.update({
      where: { id: b.id },
      data: { reminderSentAt: now },
    });
  }
  return { reminded: bookings.length };
}

/** For the staff "book a member" picker: active members at the session's branch scope. */
export async function bookableMembers(
  deps: CoreDeps,
  ctx: AuthContext,
  query: string,
) {
  await guard(deps, ctx, { permission: "bookings.manage" });
  const q = query.trim();
  if (q.length < 2) return [];
  const allowed = allowedBranchIds(ctx, "bookings.manage");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.memberProfile.findMany({
      where: {
        status: "ACTIVE",
        ...(allowed === "ALL" ? {} : { homeBranchId: { in: allowed } }),
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { memberCode: { contains: q.toUpperCase() } },
        ],
      },
      take: 10,
      orderBy: { firstName: "asc" },
    });
    return rows.map((m) => ({
      id: m.id,
      name: memberName(m),
      memberCode: m.memberCode,
    }));
  });
}

export function canSeeRoster(ctx: AuthContext, branchId: string) {
  return hasPermission(ctx, "classes.view", { branchId });
}

export type { Actor };
