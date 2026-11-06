import type { PrismaClient } from "@gym/db";
import { inOrder, withTenant } from "@gym/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { invoiceBalances, memberFinancialSummary } from "../billing/service";
import { AppError } from "../errors";
import { listMyTenants } from "../tenancy/access";
import { diffDays, fromDbDate, todayIn } from "../time/dates";
import { parseInput } from "../validation";
import {
  currentConsentState,
  normalizePhone,
  recordConsentTx,
} from "./service";

/**
 * The member app (D-08): every function takes a MemberContext resolved from the verified session
 * and only ever reads that member's rows. The same functions will back a native app later.
 */
export type MemberContext = {
  tenantId: string;
  userId: string;
  memberId: string;
  timezone: string;
  tenantName: string;
};

/** Gyms where this account has an active member profile (gym picker, D-04). */
export async function listMyMemberGyms(db: PrismaClient, userId: string) {
  const tenants = await listMyTenants(db, userId);
  const gyms: { tenantId: string; displayName: string; memberId: string }[] =
    [];
  for (const t of tenants) {
    if (t.status === "CANCELLED") continue;
    const profile = await withTenant(db, t.tenantId, (tx) =>
      tx.memberProfile.findUnique({
        where: { tenantId_userId: { tenantId: t.tenantId, userId } },
      }),
    );
    if (profile && profile.status === "ACTIVE")
      gyms.push({
        tenantId: t.tenantId,
        displayName: t.displayName,
        memberId: profile.id,
      });
  }
  return gyms;
}

/** The member context for (user, tenant), or null if the account isn't an active member there. */
export async function resolveMemberContext(
  db: PrismaClient,
  userId: string,
  tenantId: string,
): Promise<MemberContext | null> {
  return withTenant(
    db,
    tenantId,
    async (tx) => {
      const [profile, tenant] = await inOrder([
        tx.memberProfile.findUnique({
          where: { tenantId_userId: { tenantId, userId } },
        }),
        tx.tenant.findUnique({ where: { id: tenantId } }),
      ]);
      if (
        !profile ||
        profile.status !== "ACTIVE" ||
        !tenant ||
        tenant.status === "CANCELLED"
      )
        return null;
      return {
        tenantId,
        userId,
        memberId: profile.id,
        timezone: tenant.timezone,
        tenantName: tenant.displayName,
      };
    },
    { userId },
  );
}

const inMember = <T>(
  db: PrismaClient,
  mctx: MemberContext,
  fn: Parameters<typeof withTenant<T>>[2],
) => withTenant(db, mctx.tenantId, fn, { userId: mctx.userId });

/** Home screen: current membership, days left, renewal date, dues and credit. */
export async function getMemberHome(
  db: PrismaClient,
  mctx: MemberContext,
  now: Date = new Date(),
) {
  const today = todayIn(mctx.timezone, now);
  return inMember(db, mctx, async (tx) => {
    const profile = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    const memberships = await tx.membership.findMany({
      where: {
        memberId: mctx.memberId,
        status: { in: ["ACTIVE", "PAUSED", "PENDING_PAYMENT"] },
      },
      include: { plan: { select: { name: true } } },
      orderBy: { startDate: "asc" },
    });
    const current =
      memberships.find(
        (m) =>
          m.status !== "PENDING_PAYMENT" && fromDbDate(m.startDate) <= today,
      ) ??
      memberships[0] ??
      null;
    const upcoming = memberships.filter((m) => m !== current);
    const summary = await memberFinancialSummary(tx, mctx.memberId);
    return {
      name: profile.firstName,
      memberCode: profile.memberCode,
      gym: mctx.tenantName,
      current: current && {
        id: current.id,
        plan: current.plan.name,
        status: current.status,
        startDate: fromDbDate(current.startDate),
        endDate: fromDbDate(current.endDate),
        daysLeft: Math.max(0, diffDays(today, fromDbDate(current.endDate)) + 1),
        renewsOn: upcoming[0] ? fromDbDate(upcoming[0].startDate) : null,
      },
      upcoming: upcoming.map((m) => ({
        id: m.id,
        plan: m.plan.name,
        status: m.status,
        startDate: fromDbDate(m.startDate),
      })),
      outstandingMinor: summary.outstandingMinor,
      creditMinor: summary.creditMinor,
    };
  });
}

export async function listMyInvoices(db: PrismaClient, mctx: MemberContext) {
  return inMember(db, mctx, async (tx) => {
    const invoices = await tx.gymInvoice.findMany({
      where: { memberId: mctx.memberId },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }],
    });
    const payments = await tx.gymPayment.findMany({
      where: { memberId: mctx.memberId, status: "SUCCEEDED" },
      orderBy: { receivedAt: "desc" },
    });
    const balances = await invoiceBalances(
      tx,
      invoices.map((i) => i.id),
    );
    return {
      invoices: invoices.map((i) => ({ ...i, balance: balances.get(i.id)! })),
      payments,
    };
  });
}

/** One invoice, only if it is this member's (404 otherwise: never reveal other members' invoices). */
export async function getMyInvoice(
  db: PrismaClient,
  mctx: MemberContext,
  invoiceId: string,
) {
  return inMember(db, mctx, async (tx) => {
    const invoice = await tx.gymInvoice.findFirst({
      where: { id: invoiceId, memberId: mctx.memberId },
      include: {
        lines: { orderBy: { position: "asc" } },
        creditNotes: true,
        allocations: {
          where: { reversedAt: null },
          include: { payment: true },
        },
      },
    });
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.");
    const balance = (await invoiceBalances(tx, [invoice.id])).get(invoice.id)!;
    return { invoice, balance };
  });
}

const profileSchema = z.object({
  phone: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const p = normalizePhone(v);
      if (!p)
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid mobile number.",
        });
      return p ?? "";
    }),
  emergencyName: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || null),
  emergencyPhone: z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const p = normalizePhone(v);
      if (!p)
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid mobile number.",
        });
      return p;
    }),
});

export async function getMyProfile(db: PrismaClient, mctx: MemberContext) {
  return inMember(db, mctx, async (tx) => {
    const [profile, consents] = await inOrder([
      tx.memberProfile.findUniqueOrThrow({ where: { id: mctx.memberId } }),
      tx.contactConsent.findMany({
        where: { memberId: mctx.memberId },
        orderBy: { capturedAt: "desc" },
      }),
    ]);
    return { profile, consents: currentConsentState(consents) };
  });
}

/** Members may change their phone and emergency contact; everything else goes through staff. */
export async function updateMyProfile(
  db: PrismaClient,
  mctx: MemberContext,
  raw: unknown,
) {
  const input = parseInput(profileSchema, raw);
  return inMember(db, mctx, async (tx) => {
    const before = await tx.memberProfile.findUniqueOrThrow({
      where: { id: mctx.memberId },
    });
    const after = await tx.memberProfile.update({
      where: { id: mctx.memberId },
      data: input,
    });
    await recordAudit(
      tx,
      { userId: mctx.userId, tenantId: mctx.tenantId },
      {
        action: "member.self_updated",
        entityType: "MemberProfile",
        entityId: mctx.memberId,
        before: { phone: before.phone, emergencyPhone: before.emergencyPhone },
        after: { phone: after.phone, emergencyPhone: after.emergencyPhone },
      },
    );
    return after;
  });
}

/** Marketing opt-in/out by the member; applies to every later send (notify reads the latest row). */
export async function setMyMarketingConsent(
  db: PrismaClient,
  mctx: MemberContext,
  raw: unknown,
) {
  return inMember(db, mctx, async (tx) => {
    const row = await recordConsentTx(
      tx,
      mctx.tenantId,
      mctx.memberId,
      { ...(raw as object), purpose: "MARKETING" },
      {
        userId: mctx.userId,
        method: "SELF_SERVICE",
      },
    );
    await recordAudit(
      tx,
      { userId: mctx.userId, tenantId: mctx.tenantId },
      {
        action: "member.consent_changed",
        entityType: "MemberProfile",
        entityId: mctx.memberId,
        after: {
          channel: row.channel,
          purpose: row.purpose,
          status: row.status,
          by: "member",
        },
      },
    );
    return row;
  });
}
