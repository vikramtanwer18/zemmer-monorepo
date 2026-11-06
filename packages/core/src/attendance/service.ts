import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { emitEvent } from "../events";
import {
  inOrder,
  withTenant,
  type Prisma,
  type TenantTransaction,
} from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import {
  allowedBranchIds,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "../authz";
import { openInvoices } from "../billing/service";
import { classCreditsOf } from "../credits/ledger";
import { AppError } from "../errors";
import { memberName } from "../members/service";
import type { MemberContext } from "../members/self";
import { formatMoney, money } from "../money";
import {
  guard,
  inTenant,
  nowOf,
  secretsOf,
  type CoreDeps,
} from "../tenancy/deps";
import {
  addDays,
  formatClock,
  fromDbDate,
  isoWeekday,
  localMinuteOf,
  localTimeToUtc,
  parseClock,
  startOfDayUtc,
  todayIn,
  type LocalDate,
} from "../time/dates";
import { parseInput } from "../validation";
import {
  parsePassCode,
  passMac,
  PASS_STEP_SECONDS,
  stepInWindow,
  toBase64Url,
} from "./pass-code";
import {
  evaluateAccess,
  OVERRIDABLE,
  parseAccessWindows,
  rejectMessage,
  streakDays,
  visitsThisWeek,
  type MembershipForAccess,
  type RejectCode,
} from "./rules";

// --- passes ---------------------------------------------------------------------------------

function newPassId(): string {
  // 16 random bytes = 22 base64url characters; no personal data (CLAUDE.md: no PII in QR codes).
  return randomBytes(16).toString("base64url");
}

/** Issues a new pass (revoking any active one) inside the caller's transaction. */
export async function issuePassTx(
  tx: TenantTransaction,
  deps: Pick<CoreDeps, "secrets">,
  tenantId: string,
  memberId: string,
  issuedById: string | null,
  now: Date,
) {
  await tx.memberPass.updateMany({
    where: { memberId, status: "ACTIVE" },
    data: {
      status: "REVOKED",
      revokedAt: now,
      revokedById: issuedById,
      revokedReason: "Replaced by a new pass",
    },
  });
  const secret = randomBytes(32);
  try {
    return await tx.memberPass.create({
      data: {
        tenantId,
        memberId,
        passId: newPassId(),
        secretEncrypted: secretsOf(deps).encrypt(secret),
        issuedAt: now,
        issuedById,
      },
    });
  } finally {
    secret.fill(0);
  }
}

const passReasonSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
});

async function loadMemberFor(
  tx: TenantTransaction,
  ctx: AuthContext,
  memberId: string,
  key: "members.edit" | "members.view" | "attendance.scan" | "attendance.view",
) {
  const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
  if (!member) throw new AppError("NOT_FOUND", "Member not found.");
  if (!hasPermission(ctx, key, { branchId: member.homeBranchId }))
    throw new AppError(
      "FORBIDDEN",
      "You don't have permission to do that for this member.",
    );
  return member;
}

/** Staff: new secret (old phone copies stop working at once). Lost phone, shared screenshot… */
export async function reissuePass(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const { reason } = parseInput(passReasonSchema, raw);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMemberFor(tx, ctx, memberId, "members.edit");
    const pass = await issuePassTx(
      tx,
      deps,
      ctx.tenantId,
      member.id,
      ctx.userId,
      now,
    );
    await recordAudit(tx, ctx, {
      action: "member_pass.reissued",
      entityType: "MemberPass",
      entityId: pass.id,
      branchId: member.homeBranchId,
      meta: { memberId: member.id, reason },
    });
    return { issuedAt: pass.issuedAt };
  });
}

/** Staff: cancel the pass without a replacement (the card stops working until reissued). */
export async function revokePass(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "members.edit", write: true });
  const { reason } = parseInput(passReasonSchema, raw);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMemberFor(tx, ctx, memberId, "members.edit");
    const active = await tx.memberPass.findFirst({
      where: { memberId: member.id, status: "ACTIVE" },
    });
    if (!active)
      throw new AppError("CONFLICT", "This member has no active pass.");
    await tx.memberPass.update({
      where: { id: active.id },
      data: {
        status: "REVOKED",
        revokedAt: now,
        revokedById: ctx.userId,
        revokedReason: reason,
      },
    });
    await recordAudit(tx, ctx, {
      action: "member_pass.revoked",
      entityType: "MemberPass",
      entityId: active.id,
      branchId: member.homeBranchId,
      meta: { memberId: member.id, reason },
    });
  });
}

export async function getPassStatus(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
) {
  await guard(deps, ctx, { permission: "members.view" });
  return inTenant(deps, ctx, async (tx) => {
    const member = await loadMemberFor(tx, ctx, memberId, "members.view");
    const latest = await tx.memberPass.findFirst({
      where: { memberId: member.id },
      orderBy: [{ status: "asc" }, { issuedAt: "desc" }],
      select: {
        status: true,
        issuedAt: true,
        revokedAt: true,
        revokedReason: true,
      },
    });
    return latest;
  });
}

// --- member card (PWA) ----------------------------------------------------------------------

const inMember = <T>(
  deps: CoreDeps,
  mctx: MemberContext,
  fn: (tx: TenantTransaction) => Promise<T>,
) => withTenant(deps.db, mctx.tenantId, fn, { userId: mctx.userId });

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  PAUSED: "Frozen",
  PENDING_PAYMENT: "Waiting for payment",
  EXPIRED: "Expired",
};

/**
 * Everything the member's digital card needs, including the pass secret — only ever sent to the
 * member's own authenticated session (D-09). A member who has never had a pass gets one now;
 * a pass revoked by staff is not replaced automatically.
 */
export async function getMyCard(deps: CoreDeps, mctx: MemberContext) {
  const now = nowOf(deps);
  const today = todayIn(mctx.timezone, now);
  return inMember(deps, mctx, async (tx) => {
    const member = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
      include: { homeBranch: { select: { name: true } } },
    });
    // Prefer the active pass; otherwise the latest (revoked) one.
    let pass =
      (await tx.memberPass.findFirst({
        where: { memberId: member.id, status: "ACTIVE" },
      })) ??
      (await tx.memberPass.findFirst({
        where: { memberId: member.id },
        orderBy: { issuedAt: "desc" },
      }));
    if (!pass) {
      pass = await issuePassTx(tx, deps, mctx.tenantId, member.id, null, now);
      await recordAudit(
        tx,
        { system: true, tenantId: mctx.tenantId },
        {
          action: "member_pass.issued",
          entityType: "MemberPass",
          entityId: pass.id,
          meta: { memberId: member.id, via: "member app" },
        },
      );
    }
    const memberships = await loadAccessMemberships(tx, member.id);
    const access = evaluateAccess(memberships, {
      branchId: member.homeBranchId,
      homeBranchId: member.homeBranchId,
      today,
    });
    const current = access.ok
      ? access.membership
      : (memberships.find((m) => m.status !== "CANCELLED") ?? null);
    return {
      member: {
        name: memberName(member),
        memberCode: member.memberCode,
        hasPhoto: member.photoFileId !== null,
      },
      gym: mctx.tenantName,
      branch: member.homeBranch.name,
      membership: current
        ? {
            planName: current.planName,
            status: access.ok
              ? access.inGrace
                ? "In grace period"
                : "Active"
              : (STATUS_LABEL[current.status] ?? current.status),
            active: access.ok,
            endDate: current.endDate,
          }
        : null,
      pass:
        pass.status === "ACTIVE"
          ? {
              passId: pass.passId,
              secret: toBase64Url(
                new Uint8Array(secretsOf(deps).decrypt(pass.secretEncrypted)),
              ),
              stepSeconds: PASS_STEP_SECONDS,
            }
          : null,
      passRevoked: pass.status === "REVOKED",
      serverTime: now.toISOString(),
    };
  });
}

/** Check-in history and the simple streak for the member app. */
export async function getMyCheckIns(
  deps: CoreDeps,
  mctx: MemberContext,
  options: { limit?: number } = {},
) {
  const now = nowOf(deps);
  const today = todayIn(mctx.timezone, now);
  return inMember(deps, mctx, async (tx) => {
    const events = await tx.attendanceEvent.findMany({
      where: {
        memberId: mctx.memberId,
        result: "ACCEPTED",
        voidedAt: null,
      },
      orderBy: { occurredAt: "desc" },
      take: Math.min(options.limit ?? 30, 100),
      include: { branch: { select: { name: true } } },
    });
    // Streak needs every visit day back to the first gap; 120 days covers any realistic run.
    const recent = await tx.attendanceEvent.findMany({
      where: {
        memberId: mctx.memberId,
        type: "CHECK_IN",
        result: "ACCEPTED",
        voidedAt: null,
        occurredAt: { gte: startOfDayUtc(addDays(today, -120), mctx.timezone) },
      },
      select: { occurredAt: true },
    });
    const days = recent.map((e) => todayIn(mctx.timezone, e.occurredAt));
    return {
      streakDays: streakDays(days, today),
      visitsThisWeek: visitsThisWeek(days, today),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        branch: e.branch.name,
        occurredAt: e.occurredAt,
        method: e.method,
      })),
    };
  });
}

// --- eligibility ----------------------------------------------------------------------------

async function loadAccessMemberships(
  tx: TenantTransaction,
  memberId: string,
): Promise<MembershipForAccess[]> {
  const rows = await tx.membership.findMany({
    where: {
      memberId,
      status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT", "EXPIRED"] },
    },
    include: {
      plan: { include: { branches: { select: { branchId: true } } } },
    },
    orderBy: { endDate: "desc" },
    take: 20,
  });
  return rows.map((m) => ({
    id: m.id,
    status: m.status,
    startDate: fromDbDate(m.startDate),
    endDate: fromDbDate(m.endDate),
    graceDays: m.plan.graceDays,
    planName: m.plan.name,
    planCode: m.plan.code,
    accessScope: m.plan.accessScope,
    planBranchIds: m.plan.branches.map((b) => b.branchId),
    accessWindows: parseAccessWindows(m.plan.accessWindows),
    classCredits: classCreditsOf(m.plan.entitlements),
  }));
}

export { loadAccessMemberships };

type Settings = {
  checkinDuplicateMinutes: number;
  duesAtCheckin: "WARN" | "BLOCK";
  autoMarkClassAttendance: boolean;
};

async function loadSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<Settings & { currency: string }> {
  const [settings, tenant] = await inOrder([
    tx.tenantSettings.findUnique({ where: { tenantId } }),
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  ]);
  return {
    checkinDuplicateMinutes: settings?.checkinDuplicateMinutes ?? 2,
    duesAtCheckin: settings?.duesAtCheckin ?? "WARN",
    autoMarkClassAttendance: settings?.autoMarkClassAttendance ?? true,
    currency: tenant.currency,
  };
}

type Evaluation =
  | {
      ok: true;
      membership: { planName: string; endDate: LocalDate; inGrace: boolean };
      warnings: string[];
    }
  | {
      ok: false;
      code: RejectCode;
      message: string;
      membership: {
        planName: string;
        endDate: LocalDate;
        inGrace: boolean;
      } | null;
      warnings: string[];
    };

/** The D-09 rules after the pass itself is verified: member, membership, duplicates, dues. */
async function evaluateCheckIn(
  tx: TenantTransaction,
  input: {
    member: { id: string; status: string; homeBranchId: string };
    branchId: string;
    timezone: string;
    now: Date;
    settings: Settings & { currency: string };
  },
): Promise<Evaluation> {
  const { member, now, timezone, settings } = input;
  const fail = (
    code: RejectCode,
    detail: Record<string, string> = {},
    membership: Evaluation["membership"] = null,
    warnings: string[] = [],
  ): Evaluation => ({
    ok: false,
    code,
    message: rejectMessage(code, detail),
    membership,
    warnings,
  });
  if (member.status !== "ACTIVE") return fail("MEMBER_INACTIVE");
  const today = todayIn(timezone, now);
  const memberships = await loadAccessMemberships(tx, member.id);
  const access = evaluateAccess(memberships, {
    branchId: input.branchId,
    homeBranchId: member.homeBranchId,
    today,
    minuteOfDay: localMinuteOf(now, timezone),
    weekday: isoWeekday(today),
  });
  if (!access.ok) return fail(access.code, access.detail);
  const membership = {
    planName: access.membership.planName,
    endDate: access.membership.endDate,
    inGrace: access.inGrace,
  };
  const warnings: string[] = [];
  if (access.inGrace)
    warnings.push(
      `In grace period: the membership ended on ${access.membership.endDate}.`,
    );
  if (settings.checkinDuplicateMinutes > 0) {
    const last = await tx.attendanceEvent.findFirst({
      where: {
        memberId: member.id,
        type: "CHECK_IN",
        result: "ACCEPTED",
        voidedAt: null,
        occurredAt: {
          gte: new Date(
            now.getTime() - settings.checkinDuplicateMinutes * 60_000,
          ),
        },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (last)
      return fail(
        "ALREADY_CHECKED_IN",
        { time: formatClock(localMinuteOf(last.occurredAt, timezone)) },
        membership,
        warnings,
      );
  }
  const outstanding = (await openInvoices(tx, member.id)).reduce(
    (s, i) => s + i.outstandingMinor,
    0,
  );
  if (outstanding > 0) {
    const amount = formatMoney(money(outstanding, settings.currency));
    if (settings.duesAtCheckin === "BLOCK")
      return fail("DUES_OUTSTANDING", { amount }, membership, warnings);
    warnings.push(`Outstanding dues: ${amount}.`);
  }
  return { ok: true, membership, warnings };
}

/** QR check-in on the day marks the member's booked classes at that branch (setting). */
async function autoMarkBookings(
  tx: TenantTransaction,
  memberId: string,
  branchId: string,
  now: Date,
): Promise<number> {
  const result = await tx.booking.updateMany({
    where: {
      memberId,
      status: "BOOKED",
      session: {
        branchId,
        status: "SCHEDULED",
        // In progress, or starting within the next two hours.
        startsAt: { lte: new Date(now.getTime() + 2 * 3_600_000) },
        endsAt: { gte: now },
      },
    },
    data: { status: "ATTENDED", markedAt: now },
  });
  return result.count;
}

// --- scanning -------------------------------------------------------------------------------

export type ScanResult = {
  result: "ACCEPTED" | "REJECTED";
  type: "CHECK_IN" | "CHECK_OUT";
  code: RejectCode | null;
  message: string;
  eventId: string;
  occurredAt: Date;
  member: {
    id: string;
    name: string;
    memberCode: string;
    hasPhoto: boolean;
  } | null;
  membership: { planName: string; endDate: LocalDate; inGrace: boolean } | null;
  warnings: string[];
  /** Manual check-in: staff with attendance.override may check in anyway. */
  overridable: boolean;
  markedClasses: number;
};

const scanSchema = z.object({
  payload: z.string().trim().min(1, "Scan a code.").max(300),
  branchId: z.uuid("Pick a branch."),
  deviceId: z.uuid().optional(),
  type: z.enum(["CHECK_IN", "CHECK_OUT"]).default("CHECK_IN"),
});

async function loadBranch(tx: TenantTransaction, branchId: string) {
  const branch = await tx.branch.findUnique({ where: { id: branchId } });
  if (!branch || branch.status !== "ACTIVE")
    throw new AppError("VALIDATION_FAILED", "Pick an active branch.", {
      fields: { branchId: ["Pick an active branch."] },
    });
  return branch;
}

async function checkDevice(
  tx: TenantTransaction,
  deviceId: string | undefined,
  branchId: string,
  now: Date,
) {
  if (!deviceId) return null;
  const device = await tx.scanDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.status !== "ACTIVE" || device.branchId !== branchId)
    throw new AppError(
      "VALIDATION_FAILED",
      "This scanner isn't registered for this branch.",
    );
  await tx.scanDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: now },
  });
  return device.id;
}

/** Is the member checked in at this branch today (a check-in with no later check-out)? */
async function openCheckIn(
  tx: TenantTransaction,
  memberId: string,
  branchId: string,
  dayStart: Date,
) {
  const last = await tx.attendanceEvent.findFirst({
    where: {
      memberId,
      branchId,
      result: "ACCEPTED",
      voidedAt: null,
      occurredAt: { gte: dayStart },
    },
    orderBy: { occurredAt: "desc" },
  });
  return last?.type === "CHECK_IN" ? last : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * attendance.validateScan (D-09): parse → find pass → verify HMAC (constant time) → time step
 * within ±1 → one-time use → pass active → member → membership (branch, hours) → duplicate
 * window → dues → claim (Redis SET NX + DB unique index). Every scan, accepted or rejected, is
 * written as an AttendanceEvent. A code that was already used is reported as such before the
 * duplicate-window check so staff see "already used" for a replayed screenshot.
 */
export async function validateScan(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
): Promise<ScanResult> {
  const input = parseInput(scanSchema, raw);
  await guard(deps, ctx, {
    permission: "attendance.scan",
    branchId: input.branchId,
    write: true,
  });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const branch = await loadBranch(tx, input.branchId);
    const deviceId = await checkDevice(tx, input.deviceId, branch.id, now);
    if (input.type === "CHECK_OUT" && !branch.checkoutEnabled)
      throw new AppError(
        "VALIDATION_FAILED",
        "Check-out isn't turned on for this branch.",
      );
    const timezone = branch.timezone ?? ctx.timezone;
    const settings = await loadSettings(tx, ctx.tenantId);

    type MemberRow = Awaited<
      ReturnType<typeof tx.memberProfile.findUniqueOrThrow>
    >;
    const record = async (outcome: {
      result: "ACCEPTED" | "REJECTED";
      code?: RejectCode;
      member?: MemberRow | null;
      passId?: string | null;
      timeStep?: number | null;
      message?: string;
      membership?: ScanResult["membership"];
      warnings?: string[];
    }): Promise<ScanResult> => {
      const event = await tx.attendanceEvent.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: branch.id,
          memberId: outcome.member?.id ?? null,
          type: input.type,
          method: "QR",
          result: outcome.result,
          rejectCode: outcome.code ?? null,
          passId: outcome.passId ?? null,
          timeStep: outcome.timeStep ?? null,
          scannedByUserId: ctx.userId,
          deviceId,
          occurredAt: now,
        },
      });
      return {
        result: outcome.result,
        type: input.type,
        code: outcome.code ?? null,
        message:
          outcome.message ??
          (outcome.code
            ? rejectMessage(outcome.code)
            : input.type === "CHECK_IN"
              ? "Checked in."
              : "Checked out."),
        eventId: event.id,
        occurredAt: event.occurredAt,
        member: outcome.member
          ? {
              id: outcome.member.id,
              name: memberName(outcome.member),
              memberCode: outcome.member.memberCode,
              hasPhoto: outcome.member.photoFileId !== null,
            }
          : null,
        membership: outcome.membership ?? null,
        warnings: outcome.warnings ?? [],
        overridable: false,
        markedClasses: 0,
      };
    };

    const parsed = parsePassCode(input.payload);
    if (!parsed) return record({ result: "REJECTED", code: "INVALID_CODE" });
    // RLS: another gym's pass is simply not found here.
    const pass = await tx.memberPass.findUnique({
      where: { passId: parsed.passId },
    });
    if (!pass)
      return record({
        result: "REJECTED",
        code: "INVALID_CODE",
        passId: parsed.passId,
        timeStep: parsed.timeStep,
      });
    const secret = secretsOf(deps).decrypt(pass.secretEncrypted);
    const expected = await passMac(
      new Uint8Array(secret),
      pass.passId,
      parsed.timeStep,
    );
    secret.fill(0);
    if (!constantTimeEqual(expected, parsed.mac))
      // Forged or corrupted: don't attribute it to the member.
      return record({
        result: "REJECTED",
        code: "INVALID_CODE",
        passId: pass.passId,
        timeStep: parsed.timeStep,
      });
    const member = await tx.memberProfile.findUniqueOrThrow({
      where: { id: pass.memberId },
    });
    const base = { member, passId: pass.passId, timeStep: parsed.timeStep };
    if (!stepInWindow(parsed.timeStep, now.getTime()))
      return record({ ...base, result: "REJECTED", code: "CODE_EXPIRED" });
    const used = await tx.attendanceEvent.findFirst({
      where: {
        passId: pass.passId,
        timeStep: parsed.timeStep,
        method: "QR",
        result: "ACCEPTED",
      },
      select: { id: true },
    });
    if (used)
      return record({ ...base, result: "REJECTED", code: "CODE_ALREADY_USED" });
    if (pass.status !== "ACTIVE")
      return record({ ...base, result: "REJECTED", code: "PASS_REVOKED" });

    let membership: ScanResult["membership"] = null;
    let warnings: string[] = [];
    if (input.type === "CHECK_IN") {
      const evaluation = await evaluateCheckIn(tx, {
        member,
        branchId: branch.id,
        timezone,
        now,
        settings,
      });
      if (!evaluation.ok)
        return record({
          ...base,
          result: "REJECTED",
          code: evaluation.code,
          message: evaluation.message,
          membership: evaluation.membership,
          warnings: evaluation.warnings,
        });
      membership = evaluation.membership;
      warnings = evaluation.warnings;
    } else {
      const open = await openCheckIn(
        tx,
        member.id,
        branch.id,
        startOfDayUtc(todayIn(timezone, now), timezone),
      );
      if (!open)
        return record({ ...base, result: "REJECTED", code: "NOT_CHECKED_IN" });
    }

    // One-time use: Redis first (fast, stops a burst of replays), then the DB unique index.
    const claimKey = `qr:${ctx.tenantId}:${pass.passId}:${parsed.timeStep}`;
    if (
      deps.claims &&
      !(await deps.claims.claim(claimKey, PASS_STEP_SECONDS * 4))
    )
      return record({ ...base, result: "REJECTED", code: "CODE_ALREADY_USED" });
    const id = randomUUID();
    const inserted = await tx.attendanceEvent.createMany({
      data: [
        {
          id,
          tenantId: ctx.tenantId,
          branchId: branch.id,
          memberId: member.id,
          type: input.type,
          method: "QR",
          result: "ACCEPTED",
          passId: pass.passId,
          timeStep: parsed.timeStep,
          scannedByUserId: ctx.userId,
          deviceId,
          occurredAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0)
      return record({ ...base, result: "REJECTED", code: "CODE_ALREADY_USED" });
    // M7: streaks, points, milestones and challenges react to the event (not in this transaction).
    if (input.type === "CHECK_IN")
      await emitEvent(tx, ctx.tenantId, "attendance.checked_in", {
        attendanceId: id,
        memberId: member.id,
        branchId: branch.id,
        occurredAt: now.toISOString(),
      });
    const markedClasses =
      input.type === "CHECK_IN" && settings.autoMarkClassAttendance
        ? await autoMarkBookings(tx, member.id, branch.id, now)
        : 0;
    return {
      result: "ACCEPTED",
      type: input.type,
      code: null,
      message: input.type === "CHECK_IN" ? "Checked in." : "Checked out.",
      eventId: id,
      occurredAt: now,
      member: {
        id: member.id,
        name: memberName(member),
        memberCode: member.memberCode,
        hasPhoto: member.photoFileId !== null,
      },
      membership,
      warnings,
      overridable: false,
      markedClasses,
    };
  });
}

// --- manual check-in ------------------------------------------------------------------------

const manualSchema = z.object({
  memberId: z.uuid("Pick a member."),
  branchId: z.uuid("Pick a branch."),
  reason: z.string().trim().min(3, "Say why (e.g. forgot phone).").max(300),
  override: z
    .union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
  type: z.enum(["CHECK_IN", "CHECK_OUT"]).default("CHECK_IN"),
  deviceId: z.uuid().optional(),
});

/**
 * Staff check a member in without the QR (forgot phone, no app). The same rules apply; a refused
 * check-in can be overridden with attendance.override. Always audited.
 */
export async function manualCheckIn(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
): Promise<ScanResult> {
  const input = parseInput(manualSchema, raw);
  await guard(deps, ctx, {
    permission: "attendance.scan",
    branchId: input.branchId,
    write: true,
  });
  if (input.override)
    requirePermission(ctx, "attendance.override", { branchId: input.branchId });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const branch = await loadBranch(tx, input.branchId);
    const deviceId = await checkDevice(tx, input.deviceId, branch.id, now);
    const timezone = branch.timezone ?? ctx.timezone;
    const member = await tx.memberProfile.findUnique({
      where: { id: input.memberId },
    });
    if (!member) throw new AppError("NOT_FOUND", "Member not found.");
    const summary = {
      id: member.id,
      name: memberName(member),
      memberCode: member.memberCode,
      hasPhoto: member.photoFileId !== null,
    };
    if (input.type === "CHECK_OUT") {
      if (!branch.checkoutEnabled)
        throw new AppError(
          "VALIDATION_FAILED",
          "Check-out isn't turned on for this branch.",
        );
      const open = await openCheckIn(
        tx,
        member.id,
        branch.id,
        startOfDayUtc(todayIn(timezone, now), timezone),
      );
      if (!open)
        throw new AppError("CONFLICT", rejectMessage("NOT_CHECKED_IN"));
    }
    const settings = await loadSettings(tx, ctx.tenantId);
    const evaluation =
      input.type === "CHECK_IN"
        ? await evaluateCheckIn(tx, {
            member,
            branchId: branch.id,
            timezone,
            now,
            settings,
          })
        : ({ ok: true, membership: null, warnings: [] } as const);
    const canOverride =
      !evaluation.ok &&
      OVERRIDABLE.has(evaluation.code) &&
      hasPermission(ctx, "attendance.override", { branchId: branch.id });
    const accepted = evaluation.ok || (input.override && canOverride);
    if (!evaluation.ok && input.override && !OVERRIDABLE.has(evaluation.code))
      throw new AppError(
        "CONFLICT",
        `${evaluation.message} This can't be overridden.`,
      );
    const event = await tx.attendanceEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: branch.id,
        memberId: member.id,
        type: input.type,
        method: "MANUAL",
        result: accepted ? "ACCEPTED" : "REJECTED",
        rejectCode: evaluation.ok ? null : evaluation.code,
        scannedByUserId: ctx.userId,
        deviceId,
        reason: input.reason,
        overridden: !evaluation.ok && accepted,
        occurredAt: now,
      },
    });
    if (accepted && input.type === "CHECK_IN")
      await emitEvent(tx, ctx.tenantId, "attendance.checked_in", {
        attendanceId: event.id,
        memberId: member.id,
        branchId: branch.id,
        occurredAt: now.toISOString(),
      });
    if (accepted) {
      await recordAudit(tx, ctx, {
        action: evaluation.ok
          ? "attendance.manual_checkin"
          : "attendance.override",
        entityType: "AttendanceEvent",
        entityId: event.id,
        branchId: branch.id,
        meta: {
          memberId: member.id,
          type: input.type,
          reason: input.reason,
          ...(evaluation.ok ? {} : { refused: evaluation.code }),
        },
      });
    }
    const markedClasses =
      accepted && input.type === "CHECK_IN" && settings.autoMarkClassAttendance
        ? await autoMarkBookings(tx, member.id, branch.id, now)
        : 0;
    return {
      result: accepted ? "ACCEPTED" : "REJECTED",
      type: input.type,
      code: evaluation.ok ? null : evaluation.code,
      message: accepted
        ? evaluation.ok
          ? input.type === "CHECK_IN"
            ? "Checked in."
            : "Checked out."
          : `Checked in with an override. (${evaluation.message})`
        : evaluation.message,
      eventId: event.id,
      occurredAt: now,
      member: summary,
      membership: evaluation.membership,
      warnings: [...evaluation.warnings],
      overridable: !accepted && canOverride,
      markedClasses,
    };
  });
}

// --- corrections ----------------------------------------------------------------------------

const correctionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("void"),
    reason: z.string().trim().min(3, "Say why.").max(300),
  }),
  z.object({
    action: z.literal("retime"),
    /** Local wall-clock time at the branch, "HH:MM", on the same day. */
    time: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."),
    reason: z.string().trim().min(3, "Say why.").max(300),
  }),
]);

/** Remove (void) a wrong check-in, or move its time. Needs attendance.correct; audited. */
export async function correctAttendance(
  deps: CoreDeps,
  ctx: AuthContext,
  eventId: string,
  raw: unknown,
) {
  const input = parseInput(correctionSchema, raw);
  await guard(deps, ctx, { permission: "attendance.correct", write: true });
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const event = await tx.attendanceEvent.findUnique({
      where: { id: eventId },
      include: { branch: true },
    });
    if (!event) throw new AppError("NOT_FOUND", "Check-in not found.");
    requirePermission(ctx, "attendance.correct", { branchId: event.branchId });
    if (event.result !== "ACCEPTED" || event.voidedAt)
      throw new AppError(
        "CONFLICT",
        "Only current, accepted check-ins can be corrected.",
      );
    const before = { occurredAt: event.occurredAt, voided: false };
    if (input.action === "void") {
      await tx.attendanceEvent.update({
        where: { id: event.id },
        data: {
          voidedAt: now,
          voidedById: ctx.userId,
          voidReason: input.reason,
        },
      });
    } else {
      const tz = event.branch.timezone ?? ctx.timezone;
      let minute: number;
      try {
        minute = parseClock(input.time);
      } catch {
        throw new AppError("VALIDATION_FAILED", "Use HH:MM.", {
          fields: { time: ["Use HH:MM."] },
        });
      }
      const occurredAt = localTimeToUtc(
        todayIn(tz, event.occurredAt),
        minute,
        tz,
      );
      if (occurredAt.getTime() > now.getTime())
        throw new AppError("VALIDATION_FAILED", "That time is in the future.", {
          fields: { time: ["In the future."] },
        });
      await tx.attendanceEvent.update({
        where: { id: event.id },
        data: {
          occurredAt,
          originalOccurredAt: event.originalOccurredAt ?? event.occurredAt,
          correctedAt: now,
          correctedById: ctx.userId,
        },
      });
    }
    const fresh = await tx.attendanceEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    await recordAudit(tx, ctx, {
      action:
        input.action === "void" ? "attendance.voided" : "attendance.retimed",
      entityType: "AttendanceEvent",
      entityId: event.id,
      branchId: event.branchId,
      before,
      after: { occurredAt: fresh.occurredAt, voided: fresh.voidedAt !== null },
      meta: { memberId: event.memberId, reason: input.reason },
    });
    return fresh;
  });
}

// --- lists ----------------------------------------------------------------------------------

const listSchema = z.object({
  branchId: z.uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  memberId: z.uuid().optional(),
  result: z.enum(["ACCEPTED", "REJECTED", "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
});

const PAGE_SIZE = 50;

/** Attendance for a day (default today) at the branches the user may see. */
export async function listAttendance(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "attendance.view" });
  const input = parseInput(listSchema, raw);
  const now = nowOf(deps);
  const date = input.date ?? todayIn(ctx.timezone, now);
  const allowed = allowedBranchIds(ctx, "attendance.view");
  if (input.branchId)
    requirePermission(ctx, "attendance.view", { branchId: input.branchId });
  const where: Prisma.AttendanceEventWhereInput = {
    ...(input.branchId
      ? { branchId: input.branchId }
      : allowed === "ALL"
        ? {}
        : { branchId: { in: allowed } }),
    ...(input.memberId ? { memberId: input.memberId } : {}),
    ...(input.result === "all" ? {} : { result: input.result }),
    occurredAt: {
      gte: startOfDayUtc(date, ctx.timezone),
      lt: startOfDayUtc(addDays(date, 1), ctx.timezone),
    },
  };
  return inTenant(deps, ctx, async (tx) => {
    const [rows, total, checkIns, members, rejected] = await inOrder([
      tx.attendanceEvent.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              memberCode: true,
            },
          },
          branch: { select: { name: true, checkoutEnabled: true } },
          device: { select: { name: true } },
        },
      }),
      tx.attendanceEvent.count({ where }),
      tx.attendanceEvent.count({
        where: {
          ...where,
          result: "ACCEPTED",
          type: "CHECK_IN",
          voidedAt: null,
        },
      }),
      tx.attendanceEvent.groupBy({
        by: ["memberId"],
        where: {
          ...where,
          result: "ACCEPTED",
          type: "CHECK_IN",
          voidedAt: null,
        },
      }),
      tx.attendanceEvent.count({ where: { ...where, result: "REJECTED" } }),
    ]);
    const staffIds = [
      ...new Set(rows.map((r) => r.scannedByUserId).filter(Boolean)),
    ] as string[];
    const staff = staffIds.length
      ? await tx.user.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true },
        })
      : [];
    const staffName = new Map(staff.map((s) => [s.id, s.name]));
    let currentlyIn: number | null = null;
    if (input.branchId) {
      const branch = await tx.branch.findUnique({
        where: { id: input.branchId },
      });
      if (branch?.checkoutEnabled) {
        const outs = await tx.attendanceEvent.count({
          where: {
            ...where,
            result: "ACCEPTED",
            type: "CHECK_OUT",
            voidedAt: null,
          },
        });
        currentlyIn = Math.max(checkIns - outs, 0);
      }
    }
    return {
      date,
      total,
      page: input.page,
      pageSize: PAGE_SIZE,
      summary: {
        checkIns,
        uniqueMembers: members.filter((m) => m.memberId).length,
        rejected,
        currentlyIn,
      },
      rows: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt,
        type: r.type,
        method: r.method,
        result: r.result,
        rejectCode: r.rejectCode,
        rejectMessage: r.rejectCode
          ? rejectMessage(r.rejectCode as RejectCode)
          : null,
        reason: r.reason,
        overridden: r.overridden,
        voided: r.voidedAt !== null,
        voidReason: r.voidReason,
        corrected: r.correctedAt !== null,
        member: r.member
          ? {
              id: r.member.id,
              name: memberName(r.member),
              memberCode: r.member.memberCode,
            }
          : null,
        branch: r.branch.name,
        device: r.device?.name ?? null,
        staff: r.scannedByUserId
          ? (staffName.get(r.scannedByUserId) ?? null)
          : null,
      })),
    };
  });
}

/** Members to pick from for a manual check-in (name, code, phone), at allowed branches. */
export async function searchMembersForCheckIn(
  deps: CoreDeps,
  ctx: AuthContext,
  query: string,
) {
  await guard(deps, ctx, { permission: "attendance.scan" });
  const q = query.trim();
  if (q.length < 2) return [];
  const allowed = allowedBranchIds(ctx, "attendance.scan");
  const digits = q.replace(/\D/g, "");
  return inTenant(deps, ctx, async (tx) => {
    const rows = await tx.memberProfile.findMany({
      where: {
        status: "ACTIVE",
        ...(allowed === "ALL" ? {} : { homeBranchId: { in: allowed } }),
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { memberCode: { contains: q.toUpperCase() } },
          ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
        ],
      },
      take: 10,
      orderBy: { firstName: "asc" },
      include: { homeBranch: { select: { name: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      name: memberName(m),
      memberCode: m.memberCode,
      branch: m.homeBranch.name,
      phoneLast4: m.phone ? m.phone.slice(-4) : null,
    }));
  });
}

/** A member's recent check-ins (staff member page). */
export async function memberAttendance(
  deps: CoreDeps,
  ctx: AuthContext,
  memberId: string,
  limit = 20,
) {
  await guard(deps, ctx, { permission: "attendance.view" });
  return inTenant(deps, ctx, async (tx) => {
    await loadMemberFor(tx, ctx, memberId, "attendance.view");
    const rows = await tx.attendanceEvent.findMany({
      where: { memberId },
      orderBy: { occurredAt: "desc" },
      take: limit,
      include: { branch: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      type: r.type,
      method: r.method,
      result: r.result,
      rejectMessage: r.rejectCode
        ? rejectMessage(r.rejectCode as RejectCode)
        : null,
      voided: r.voidedAt !== null,
      branch: r.branch.name,
      reason: r.reason,
      overridden: r.overridden,
    }));
  });
}

// --- scan devices ---------------------------------------------------------------------------

const deviceSchema = z.object({
  branchId: z.uuid("Pick a branch."),
  name: z.string().trim().min(2, "Give it a name.").max(60),
});

export async function listScanDevices(
  deps: CoreDeps,
  ctx: AuthContext,
  branchId?: string,
) {
  await guard(deps, ctx, { permission: "attendance.scan" });
  const allowed = allowedBranchIds(ctx, "attendance.scan");
  return inTenant(deps, ctx, (tx) =>
    tx.scanDevice.findMany({
      where: {
        status: "ACTIVE",
        ...(branchId
          ? { branchId }
          : allowed === "ALL"
            ? {}
            : { branchId: { in: allowed } }),
      },
      orderBy: { name: "asc" },
      include: { branch: { select: { name: true } } },
    }),
  );
}

export async function createScanDevice(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  const input = parseInput(deviceSchema, raw);
  await guard(deps, ctx, {
    permission: "staff.manage",
    branchId: input.branchId,
    write: true,
  });
  return inTenant(deps, ctx, async (tx) => {
    await loadBranch(tx, input.branchId);
    const clash = await tx.scanDevice.findFirst({
      where: { branchId: input.branchId, name: input.name },
    });
    if (clash)
      throw new AppError(
        "CONFLICT",
        "A scanner with that name already exists.",
        {
          fields: { name: ["Already used at this branch."] },
        },
      );
    const device = await tx.scanDevice.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        name: input.name,
        createdById: ctx.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: "scan_device.created",
      entityType: "ScanDevice",
      entityId: device.id,
      branchId: device.branchId,
      after: { name: device.name },
    });
    return device;
  });
}

export async function archiveScanDevice(
  deps: CoreDeps,
  ctx: AuthContext,
  deviceId: string,
) {
  await guard(deps, ctx, { permission: "staff.manage", write: true });
  return inTenant(deps, ctx, async (tx) => {
    const device = await tx.scanDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw new AppError("NOT_FOUND", "Scanner not found.");
    requirePermission(ctx, "staff.manage", { branchId: device.branchId });
    await tx.scanDevice.update({
      where: { id: device.id },
      data: { status: "ARCHIVED" },
    });
    await recordAudit(tx, ctx, {
      action: "scan_device.archived",
      entityType: "ScanDevice",
      entityId: device.id,
      branchId: device.branchId,
    });
  });
}

/** Branches where the caller may scan, with their check-out setting (scan page). */
export async function listScanBranches(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "attendance.scan" });
  const allowed = allowedBranchIds(ctx, "attendance.scan");
  return inTenant(deps, ctx, (tx) =>
    tx.branch.findMany({
      where: {
        status: "ACTIVE",
        ...(allowed === "ALL" ? {} : { id: { in: allowed } }),
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, checkoutEnabled: true },
    }),
  );
}
