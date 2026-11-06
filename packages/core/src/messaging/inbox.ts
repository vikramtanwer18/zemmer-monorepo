import { z } from "zod";
import { recordAudit } from "../audit";
import type { AuthContext } from "../authz";
import { normalizePhone } from "../members/service";
import { AppError } from "../errors";
import { guard, inTenant, nowOf, type CoreDeps } from "../tenancy/deps";
import { parseInput } from "../validation";
import { currentAccountTx } from "./accounts";
import {
  findContactByPhoneTx,
  recordOptInTx,
  recordOptOutTx,
} from "./contacts";
import { SKIP_REASONS, withinServiceWindow } from "./rules";
import { queueMessageTx } from "./send";
import { factsForSubjectTx } from "./facts";
import { resolveVariables, variableMapSchema } from "./variables";

/** Minimal inbox (M6 §3): threads per number, reply inside the 24-hour window, assign to staff. */
const inboxGuard = (deps: CoreDeps, ctx: AuthContext, write = false) =>
  guard(deps, ctx, {
    permission: "messaging.send",
    entitlement: "whatsapp.enabled",
    write,
  });

export async function listConversations(
  deps: CoreDeps,
  ctx: AuthContext,
  options: { mine?: boolean; unread?: boolean; take?: number } = {},
) {
  await inboxGuard(deps, ctx);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const account = await currentAccountTx(tx);
    if (!account) return { account: null, rows: [] };
    const rows = await tx.conversation.findMany({
      where: {
        accountId: account.id,
        ...(options.mine ? { assigneeUserId: ctx.userId } : {}),
        ...(options.unread ? { unread: { gt: 0 } } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: options.take ?? 50,
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        lead: { select: { id: true, firstName: true, lastName: true } },
        inbound: {
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: { text: true, receivedAt: true },
        },
      },
    });
    return {
      account: { id: account.id, displayPhone: account.displayPhone },
      rows: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.member
          ? [r.member.firstName, r.member.lastName].filter(Boolean).join(" ")
          : r.lead
            ? [r.lead.firstName, r.lead.lastName].filter(Boolean).join(" ")
            : (r.profileName ?? r.phone),
        member: r.member,
        lead: r.lead,
        unread: r.unread,
        assigneeUserId: r.assigneeUserId,
        lastMessageAt: r.lastMessageAt,
        lastText: r.inbound[0]?.text ?? null,
        windowOpen: withinServiceWindow(r.lastInboundAt, now),
      })),
    };
  });
}

export async function getConversation(
  deps: CoreDeps,
  ctx: AuthContext,
  conversationId: string,
) {
  await inboxGuard(deps, ctx);
  const now = nowOf(deps);
  return inTenant(deps, ctx, async (tx) => {
    const c = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
          },
        },
        lead: { select: { id: true, firstName: true, lastName: true } },
        inbound: { orderBy: { receivedAt: "asc" }, take: 200 },
      },
    });
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
    const outbound = await tx.outboundMessage.findMany({
      where: { accountId: c.accountId, toPhone: c.phone },
      orderBy: { queuedAt: "asc" },
      take: 200,
      select: {
        id: true,
        kind: true,
        body: true,
        templateName: true,
        status: true,
        skipReason: true,
        errorMessage: true,
        queuedAt: true,
        sentAt: true,
        purpose: true,
      },
    });
    const suppressed = await tx.suppressionRecord.findFirst({
      where: { channel: "WHATSAPP", address: c.phone, liftedAt: null },
      select: { id: true, reason: true, createdAt: true },
    });
    if (c.unread)
      await tx.conversation.update({
        where: { id: c.id },
        data: { unread: 0 },
      });
    const timeline = [
      ...c.inbound.map((m) => ({
        id: m.id,
        direction: "IN" as const,
        at: m.receivedAt,
        text: m.text,
        type: m.type,
        keyword: m.keyword,
      })),
      ...outbound.map((m) => ({
        id: m.id,
        direction: "OUT" as const,
        at: m.sentAt ?? m.queuedAt,
        text: m.body,
        template: m.templateName,
        status: m.status,
        note: m.skipReason
          ? (SKIP_REASONS[m.skipReason as keyof typeof SKIP_REASONS] ??
            m.skipReason)
          : m.errorMessage,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      id: c.id,
      phone: c.phone,
      profileName: c.profileName,
      member: c.member,
      lead: c.lead,
      assigneeUserId: c.assigneeUserId,
      windowOpen: withinServiceWindow(c.lastInboundAt, now),
      windowClosesAt: c.lastInboundAt
        ? new Date(c.lastInboundAt.getTime() + 86_400_000)
        : null,
      suppressed,
      timeline,
    };
  });
}

const replySchema = z.object({
  body: z.string().trim().min(1, "Type a message.").max(4096),
});

/** Free-text reply: only inside the 24-hour window (checked here and again at send time). */
export async function replyToConversation(
  deps: CoreDeps,
  ctx: AuthContext,
  conversationId: string,
  raw: unknown,
) {
  await inboxGuard(deps, ctx, true);
  const { body } = parseInput(replySchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    const c = await tx.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
    if (!withinServiceWindow(c.lastInboundAt, nowOf(deps)))
      throw new AppError(
        "CONFLICT",
        "More than 24 hours since their last message: send a template instead.",
        {
          details: { code: "OUTSIDE_WINDOW" },
        },
      );
    const result = await queueMessageTx(tx, ctx.tenantId, {
      kind: "TEXT",
      toPhone: c.phone,
      memberId: c.memberId,
      leadId: c.leadId,
      body,
      purpose: "INBOX",
      idempotencyKey: `reply:${c.id}:${nowOf(deps).getTime()}`,
      createdById: ctx.userId,
    });
    if (!result.queued)
      throw new AppError("CONFLICT", "WhatsApp isn't connected.");
    if (!c.assigneeUserId)
      await tx.conversation.update({
        where: { id: c.id },
        data: { assigneeUserId: ctx.userId },
      });
    return { id: result.id };
  });
}

export async function assignConversation(
  deps: CoreDeps,
  ctx: AuthContext,
  conversationId: string,
  raw: unknown,
) {
  await inboxGuard(deps, ctx, true);
  const { userId } = parseInput(z.object({ userId: z.uuid().nullable() }), raw);
  return inTenant(deps, ctx, async (tx) => {
    const c = await tx.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
    if (userId) {
      const staff = await tx.tenantMembership.findFirst({
        where: { userId, status: "ACTIVE" },
      });
      if (!staff)
        throw new AppError("VALIDATION_FAILED", "Pick someone on your staff.");
    }
    await tx.conversation.update({
      where: { id: c.id },
      data: { assigneeUserId: userId },
    });
    await recordAudit(tx, ctx, {
      action: "conversation.assigned",
      entityType: "Conversation",
      entityId: c.id,
      meta: { to: userId },
    });
  });
}

const sendTemplateSchema = z.object({
  templateId: z.uuid(),
  memberId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  phone: z.string().trim().optional(),
  variables: variableMapSchema.default({}),
});

/**
 * One template to one person (inbox "send template", retention dashboard one-click). Consent,
 * suppression and the daily cap are checked at send time like every other send.
 */
export async function sendTemplateToContact(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
  options: { flagId?: string } = {},
) {
  await inboxGuard(deps, ctx, true);
  const input = parseInput(sendTemplateSchema, raw);
  return inTenant(deps, ctx, async (tx) => {
    let phone: string | null = null;
    let memberId: string | null = null;
    let leadId: string | null = null;
    if (input.memberId) {
      const m = await tx.memberProfile.findUnique({
        where: { id: input.memberId },
        select: { id: true, phone: true },
      });
      if (!m) throw new AppError("NOT_FOUND", "Member not found.");
      ({ phone, id: memberId } = m);
    } else if (input.leadId) {
      const l = await tx.lead.findUnique({
        where: { id: input.leadId },
        select: { id: true, phone: true },
      });
      if (!l) throw new AppError("NOT_FOUND", "Lead not found.");
      ({ phone, id: leadId } = l);
    } else if (input.phone) {
      phone = normalizePhone(input.phone);
      if (!phone)
        throw new AppError(
          "VALIDATION_FAILED",
          "Enter a valid mobile number.",
          { fields: { phone: ["Invalid number."] } },
        );
      const contact = await findContactByPhoneTx(tx, phone);
      memberId = contact.memberId;
      leadId = contact.leadId;
    }
    if (!phone) throw new AppError("VALIDATION_FAILED", SKIP_REASONS.NO_PHONE);
    const template = await tx.messageTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (!template || template.status !== "APPROVED")
      throw new AppError("VALIDATION_FAILED", "Pick an approved template.");
    const facts = await factsForSubjectTx(
      tx,
      ctx.tenantId,
      { memberId, leadId },
      nowOf(deps),
    );
    const result = await queueMessageTx(tx, ctx.tenantId, {
      kind: "TEMPLATE",
      templateId: template.id,
      values: resolveVariables(input.variables, facts),
      toPhone: phone,
      memberId,
      leadId,
      purpose: "INBOX",
      idempotencyKey: `manual:${template.id}:${phone}:${Math.floor(nowOf(deps).getTime() / 60_000)}`,
      createdById: ctx.userId,
    });
    if (!result.queued)
      throw new AppError("CONFLICT", "WhatsApp isn't connected.");
    if (options.flagId)
      await tx.retentionFlag.updateMany({
        where: { id: options.flagId, status: "OPEN" },
        data: {
          status: "ACTIONED",
          action: `Sent ${template.name}`,
          actionedAt: nowOf(deps),
          actionedById: ctx.userId,
        },
      });
    await recordAudit(tx, ctx, {
      action: "whatsapp.template_sent",
      entityType: "OutboundMessage",
      entityId: result.id,
      meta: { template: template.name, memberId, leadId },
    });
    return { id: result.id, created: result.created };
  });
}

// --- opt-outs managed by staff ----------------------------------------------------------------

export async function listSuppressions(deps: CoreDeps, ctx: AuthContext) {
  await guard(deps, ctx, { permission: "messaging.send" });
  return inTenant(deps, ctx, (tx) =>
    tx.suppressionRecord.findMany({
      where: { channel: "WHATSAPP", liftedAt: null },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  );
}

const suppressSchema = z.object({
  phone: z.string().trim().min(6),
  note: z.string().trim().min(3, "Say why (e.g. asked at the desk).").max(300),
});

/** Staff record an opt-out the person gave in person or by phone. */
export async function addSuppression(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "messaging.send", write: true });
  const input = parseInput(suppressSchema, raw);
  const phone = normalizePhone(input.phone);
  if (!phone)
    throw new AppError("VALIDATION_FAILED", "Enter a valid mobile number.", {
      fields: { phone: ["Invalid number."] },
    });
  return inTenant(deps, ctx, async (tx) => {
    const contact = await findContactByPhoneTx(tx, phone);
    const r = await recordOptOutTx(
      tx,
      ctx.tenantId,
      phone,
      contact,
      `Staff: ${input.note}`,
      { userId: ctx.userId, reason: "MANUAL" },
    );
    await recordAudit(tx, ctx, {
      action: "whatsapp.suppressed",
      entityType: "SuppressionRecord",
      meta: { phoneLast4: phone.slice(-4), note: input.note },
    });
    return r;
  });
}

/** Lifting an opt-out needs the person's new consent; the evidence is kept with the consent row. */
export async function liftSuppression(
  deps: CoreDeps,
  ctx: AuthContext,
  raw: unknown,
) {
  await guard(deps, ctx, { permission: "messaging.configure", write: true });
  const input = parseInput(
    z.object({
      phone: z.string().trim().min(6),
      evidence: z
        .string()
        .trim()
        .min(10, "Record how they agreed to messages again.")
        .max(300),
    }),
    raw,
  );
  const phone = normalizePhone(input.phone);
  if (!phone)
    throw new AppError("VALIDATION_FAILED", "Enter a valid mobile number.");
  return inTenant(deps, ctx, async (tx) => {
    const contact = await findContactByPhoneTx(tx, phone);
    const r = await recordOptInTx(
      tx,
      ctx.tenantId,
      phone,
      contact,
      `Staff: ${input.evidence}`,
      { userId: ctx.userId },
    );
    await recordAudit(tx, ctx, {
      action: "whatsapp.suppression_lifted",
      entityType: "SuppressionRecord",
      meta: { phoneLast4: phone.slice(-4), evidence: input.evidence },
    });
    return r;
  });
}
