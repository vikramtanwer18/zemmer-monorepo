import type { TenantTransaction } from "@gym/db";
import { resolveConsent } from "./rules";

/**
 * Who a phone number is, whether we may message it, and the opt-out records (M6 §2).
 * Phones are E.164 everywhere in our tables.
 */

export async function isSuppressedTx(
  tx: TenantTransaction,
  phone: string,
): Promise<boolean> {
  const row = await tx.suppressionRecord.findFirst({
    where: { channel: "WHATSAPP", address: phone, liftedAt: null },
    select: { id: true },
  });
  return !!row;
}

/**
 * Latest WhatsApp consent for the person. Members: service yes unless revoked (needed to run
 * the membership), marketing only when granted. Leads: service yes (they enquired), marketing
 * when the form/staff recorded it (M5 `marketingConsent`) unless a later row says otherwise.
 * Unknown numbers (someone who just messaged us): service yes for replies, marketing no.
 */
export async function consentForTx(
  tx: TenantTransaction,
  subject: { memberId?: string | null; leadId?: string | null },
): Promise<{ service: boolean; marketing: boolean }> {
  if (subject.memberId) {
    const history = await tx.contactConsent.findMany({
      where: { memberId: subject.memberId, channel: "WHATSAPP" },
      select: { purpose: true, status: true, capturedAt: true },
    });
    return resolveConsent(history, { service: true, marketing: false });
  }
  if (subject.leadId) {
    const [lead, history] = [
      await tx.lead.findUnique({
        where: { id: subject.leadId },
        select: { marketingConsent: true },
      }),
      await tx.contactConsent.findMany({
        where: { leadId: subject.leadId, channel: "WHATSAPP" },
        select: { purpose: true, status: true, capturedAt: true },
      }),
    ];
    return resolveConsent(history, {
      service: true,
      marketing: lead?.marketingConsent ?? false,
    });
  }
  return { service: true, marketing: false };
}

/** Member first (current members over archived), then the newest open lead with that number. */
export async function findContactByPhoneTx(
  tx: TenantTransaction,
  phone: string,
) {
  const member = await tx.memberProfile.findFirst({
    where: { phone, anonymizedAt: null },
    orderBy: [{ status: "asc" }, { joinedAt: "desc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      homeBranchId: true,
      status: true,
    },
  });
  if (member && member.status !== "ARCHIVED")
    return { memberId: member.id, leadId: null, name: member.firstName };
  const lead = await tx.lead.findFirst({
    where: { phone, convertedMemberId: null },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: { id: true, firstName: true },
  });
  if (lead) return { memberId: null, leadId: lead.id, name: lead.firstName };
  if (member)
    return { memberId: member.id, leadId: null, name: member.firstName };
  return { memberId: null, leadId: null, name: null };
}

/** Opt-out: suppression (all future sends) + a REVOKED marketing consent row for the person. */
export async function recordOptOutTx(
  tx: TenantTransaction,
  tenantId: string,
  phone: string,
  subject: { memberId: string | null; leadId: string | null },
  evidence: string,
  by: {
    userId: string | null;
    reason?: "OPT_OUT" | "BLOCKED" | "BOUNCED" | "MANUAL";
  } = { userId: null },
): Promise<{ suppressed: boolean }> {
  // Partial unique index: at most one active record per number (a repeat STOP changes nothing).
  const created = await tx.suppressionRecord.createMany({
    data: [
      {
        tenantId,
        channel: "WHATSAPP",
        address: phone,
        reason: by.reason ?? "OPT_OUT",
        note: evidence.slice(0, 300),
        createdById: by.userId,
      },
    ],
    skipDuplicates: true,
  });
  if (subject.memberId || subject.leadId)
    await tx.contactConsent.create({
      data: {
        tenantId,
        memberId: subject.memberId,
        leadId: subject.memberId ? null : subject.leadId,
        channel: "WHATSAPP",
        purpose: "MARKETING",
        status: "REVOKED",
        method: by.userId ? "STAFF_FORM" : "INBOUND_KEYWORD",
        capturedByUserId: by.userId,
        evidence: evidence.slice(0, 300),
      },
    });
  // Messages already queued for this number stop now, not at the next send attempt.
  await tx.outboundMessage.updateMany({
    where: { toPhone: phone, status: "QUEUED", category: "MARKETING" },
    data: { status: "SKIPPED", skipReason: "SUPPRESSED" },
  });
  return { suppressed: created.count === 1 };
}

/** Opt back in ("START"): lifts the suppression and records marketing consent with the words used. */
export async function recordOptInTx(
  tx: TenantTransaction,
  tenantId: string,
  phone: string,
  subject: { memberId: string | null; leadId: string | null },
  evidence: string,
  by: { userId: string | null } = { userId: null },
) {
  const lifted = await tx.suppressionRecord.updateMany({
    where: { channel: "WHATSAPP", address: phone, liftedAt: null },
    data: { liftedAt: new Date(), liftedById: by.userId },
  });
  if (subject.memberId || subject.leadId)
    await tx.contactConsent.create({
      data: {
        tenantId,
        memberId: subject.memberId,
        leadId: subject.memberId ? null : subject.leadId,
        channel: "WHATSAPP",
        purpose: "MARKETING",
        status: "GRANTED",
        method: by.userId ? "STAFF_FORM" : "INBOUND_KEYWORD",
        capturedByUserId: by.userId,
        evidence: evidence.slice(0, 300),
      },
    });
  return { lifted: lifted.count };
}
