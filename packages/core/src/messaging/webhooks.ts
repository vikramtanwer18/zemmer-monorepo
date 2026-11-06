import {
  withTenant,
  type Prisma,
  type PrismaClient,
  type TenantTransaction,
} from "@gym/db";
import {
  parseMetaWebhook,
  verifyMetaSignature,
  type WhatsAppWebhookItem,
} from "@gym/integrations/whatsapp";
import { timingSafeEqual } from "node:crypto";
import { nowOf, type CoreDeps } from "../tenancy/deps";
import {
  findContactByPhoneTx,
  recordOptInTx,
  recordOptOutTx,
} from "./contacts";
import { fromMetaPhone, matchKeyword, nextOutboundStatus } from "./rules";
import { KEYWORD_REPLY_PREFIX, queueMessageTx } from "./send";

/**
 * One platform endpoint for every gym's WABA (D-12). The body is trusted only after the
 * `X-Hub-Signature-256` check with the Meta app secret; then each item is routed to its tenant
 * by phone number id (or WABA id for template updates), stored once per dedupe key and queued.
 * Items for unknown or disconnected numbers are dropped (and counted), never guessed.
 */

/** GET handshake: echo the challenge only when the verify token matches (constant time). */
export function answerWebhookChallenge(
  params: URLSearchParams,
  verifyToken: string | undefined,
): { status: 200; body: string } | { status: 403 } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !verifyToken || !challenge)
    return { status: 403 };
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 403 };
  return { status: 200, body: challenge };
}

function dedupeKey(item: WhatsAppWebhookItem): string {
  switch (item.kind) {
    case "INBOUND":
      return `inbound:${item.messageId}`;
    case "STATUS":
      return `status:${item.messageId}:${item.status}`;
    case "TEMPLATE_STATUS":
      return `template:${item.templateId ?? item.name}:${item.language}:${item.status}`;
  }
}

export type WebhookReceipt = {
  accepted: number;
  duplicates: number;
  unrouted: number;
};

export async function receiveWhatsAppWebhook(
  db: PrismaClient,
  input: {
    rawBody: string;
    signature: string | null;
    appSecret: string | undefined;
  },
): Promise<{ ok: false; status: 401 | 400 } | ({ ok: true } & WebhookReceipt)> {
  if (
    !input.appSecret ||
    !verifyMetaSignature(input.rawBody, input.signature, input.appSecret)
  )
    return { ok: false, status: 401 };
  let items: WhatsAppWebhookItem[];
  try {
    items = parseMetaWebhook(input.rawBody);
  } catch {
    return { ok: false, status: 400 };
  }
  const receipt: WebhookReceipt = { accepted: 0, duplicates: 0, unrouted: 0 };
  for (const item of items) {
    const routes = await db.$queryRaw<
      { tenant_id: string; account_id: string }[]
    >`
      SELECT tenant_id::text, account_id::text FROM app.whatsapp_route(${item.phoneNumberId}, ${item.wabaId})`;
    const route = routes[0];
    if (!route) {
      receipt.unrouted++;
      continue;
    }
    const stored = await withTenant(db, route.tenant_id, async (tx) => {
      // The number must still belong to the same WABA the payload names.
      const account = await tx.whatsAppAccount.findUnique({
        where: { id: route.account_id },
        select: { wabaId: true },
      });
      if (!account || (item.wabaId && account.wabaId !== item.wabaId))
        return "unrouted" as const;
      const key = dedupeKey(item);
      const created = await tx.messageEvent.createMany({
        data: [
          {
            tenantId: route.tenant_id,
            accountId: route.account_id,
            kind: item.kind,
            dedupeKey: key,
            payload: item as unknown as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0) return "duplicate" as const;
      const row = await tx.messageEvent.findUniqueOrThrow({
        where: {
          tenantId_dedupeKey: { tenantId: route.tenant_id, dedupeKey: key },
        },
        select: { id: true },
      });
      await tx.outbox.create({
        data: {
          tenantId: route.tenant_id,
          topic: "message.event",
          payload: { messageEventId: row.id },
        },
      });
      return "accepted" as const;
    });
    if (stored === "accepted") receipt.accepted++;
    else if (stored === "duplicate") receipt.duplicates++;
    else receipt.unrouted++;
  }
  return { ok: true, ...receipt };
}

export class EventNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventNotReadyError";
  }
}

/**
 * Worker side. Idempotent: PROCESSED/IGNORED events are left alone. A status for a message we
 * haven't recorded the provider id of yet (webhook raced the send response) throws
 * EventNotReadyError so the job retries; on the final attempt it is IGNORED.
 */
export async function processMessageEvent(
  deps: CoreDeps,
  tenantId: string,
  messageEventId: string,
  options: { finalAttempt: boolean } = { finalAttempt: false },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    // One worker per event at a time; the second sees PROCESSED and stops.
    await tx.$queryRaw`SELECT id FROM app.message_event WHERE id = ${messageEventId}::uuid FOR UPDATE`;
    const ev = await tx.messageEvent.findUnique({
      where: { id: messageEventId },
    });
    if (!ev || ev.status === "PROCESSED" || ev.status === "IGNORED")
      return { status: ev?.status ?? "MISSING" };
    const item = ev.payload as unknown as WhatsAppWebhookItem;
    let outcome: { status: "PROCESSED" | "IGNORED"; note?: string };
    if (item.kind === "STATUS")
      outcome = await applyStatus(tx, tenantId, item, options.finalAttempt);
    else if (item.kind === "INBOUND")
      outcome = await applyInbound(deps, tx, tenantId, ev.accountId, item);
    else outcome = await applyTemplateStatus(tx, ev.accountId, item);
    await tx.messageEvent.update({
      where: { id: ev.id },
      data: {
        status: outcome.status,
        processedAt: nowOf(deps),
        attempts: { increment: 1 },
        error: outcome.note ?? null,
      },
    });
    return outcome;
  });
}

async function applyStatus(
  tx: TenantTransaction,
  tenantId: string,
  item: Extract<WhatsAppWebhookItem, { kind: "STATUS" }>,
  finalAttempt: boolean,
): Promise<{ status: "PROCESSED" | "IGNORED"; note?: string }> {
  const msg = await tx.outboundMessage.findUnique({
    where: {
      tenantId_providerMessageId: {
        tenantId,
        providerMessageId: item.messageId,
      },
    },
  });
  if (!msg) {
    if (!finalAttempt)
      throw new EventNotReadyError(`No outbound message ${item.messageId} yet`);
    return { status: "IGNORED", note: "No matching outbound message" };
  }
  const next = nextOutboundStatus(msg.status, item.status);
  if (!next)
    return {
      status: "PROCESSED",
      note: `Stale status ${item.status} (is ${msg.status})`,
    };
  const at = item.timestamp ? new Date(item.timestamp * 1000) : new Date();
  await tx.outboundMessage.update({
    where: { id: msg.id },
    data: {
      status: next,
      pricingCategory: item.pricingCategory ?? msg.pricingCategory,
      ...(next === "DELIVERED" ? { deliveredAt: at } : {}),
      ...(next === "READ"
        ? { readAt: at, deliveredAt: msg.deliveredAt ?? at }
        : {}),
      ...(next === "FAILED"
        ? {
            failedAt: at,
            errorCode: item.errorCode ?? null,
            errorMessage: item.errorTitle?.slice(0, 500) ?? null,
          }
        : {}),
    },
  });
  await tx.campaignRecipient.updateMany({
    where: { outboundMessageId: msg.id },
    data: {
      status: next,
      ...(next === "FAILED"
        ? { skipReason: item.errorTitle?.slice(0, 200) ?? null }
        : {}),
    },
  });
  return { status: "PROCESSED" };
}

async function applyInbound(
  deps: CoreDeps,
  tx: TenantTransaction,
  tenantId: string,
  accountId: string,
  item: Extract<WhatsAppWebhookItem, { kind: "INBOUND" }>,
): Promise<{ status: "PROCESSED" | "IGNORED"; note?: string }> {
  if (!item.from) return { status: "IGNORED", note: "No sender" };
  const phone = fromMetaPhone(item.from);
  const receivedAt = item.timestamp
    ? new Date(item.timestamp * 1000)
    : nowOf(deps);
  const contact = await findContactByPhoneTx(tx, phone);
  const existing = await tx.conversation.findUnique({
    where: { tenantId_accountId_phone: { tenantId, accountId, phone } },
  });
  const conversation = existing
    ? await tx.conversation.update({
        where: { id: existing.id },
        data: {
          profileName: item.profileName ?? existing.profileName,
          memberId: existing.memberId ?? contact.memberId,
          leadId: existing.leadId ?? contact.leadId,
          // Out-of-order delivery: the window runs from the latest message we've seen.
          lastInboundAt:
            !existing.lastInboundAt || existing.lastInboundAt < receivedAt
              ? receivedAt
              : existing.lastInboundAt,
          lastMessageAt:
            !existing.lastMessageAt || existing.lastMessageAt < receivedAt
              ? receivedAt
              : existing.lastMessageAt,
          unread: { increment: 1 },
        },
      })
    : await tx.conversation.create({
        data: {
          tenantId,
          accountId,
          phone,
          profileName: item.profileName,
          memberId: contact.memberId,
          leadId: contact.leadId,
          lastInboundAt: receivedAt,
          lastMessageAt: receivedAt,
          unread: 1,
        },
      });
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { optOutKeywords: true, optInKeywords: true },
  });
  const keyword = matchKeyword(
    item.text,
    settings?.optOutKeywords ?? ["stop"],
    settings?.optInKeywords ?? ["start"],
  );
  const created = await tx.inboundMessage.createMany({
    data: [
      {
        tenantId,
        conversationId: conversation.id,
        providerMessageId: item.messageId,
        type: item.type,
        text: item.text?.slice(0, 4096) ?? null,
        receivedAt,
        keyword: keyword ? `${keyword.kind}:${keyword.keyword}` : null,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0)
    return { status: "PROCESSED", note: "Duplicate inbound" };
  if (!keyword) return { status: "PROCESSED" };

  const subject = {
    memberId: conversation.memberId,
    leadId: conversation.leadId,
  };
  const gym = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { displayName: true },
  });
  const evidence = `WhatsApp message "${(item.text ?? "").slice(0, 60)}" at ${receivedAt.toISOString()}`;
  if (keyword.kind === "OPT_OUT") {
    await recordOptOutTx(tx, tenantId, phone, subject, evidence);
    await queueMessageTx(tx, tenantId, {
      kind: "TEXT",
      toPhone: phone,
      ...subject,
      purpose: "INBOX",
      idempotencyKey: `${KEYWORD_REPLY_PREFIX}${item.messageId}`,
      body: `You won't get any more WhatsApp messages from ${gym.displayName}. Reply START to opt back in.`,
    });
  } else {
    await recordOptInTx(tx, tenantId, phone, subject, evidence);
    await queueMessageTx(tx, tenantId, {
      kind: "TEXT",
      toPhone: phone,
      ...subject,
      purpose: "INBOX",
      idempotencyKey: `${KEYWORD_REPLY_PREFIX}${item.messageId}`,
      body: `You're subscribed to WhatsApp updates from ${gym.displayName} again. Reply STOP any time to opt out.`,
    });
  }
  return { status: "PROCESSED", note: keyword.kind };
}

async function applyTemplateStatus(
  tx: TenantTransaction,
  accountId: string,
  item: Extract<WhatsAppWebhookItem, { kind: "TEMPLATE_STATUS" }>,
): Promise<{ status: "PROCESSED" | "IGNORED"; note?: string }> {
  const where = item.templateId
    ? { accountId, providerTemplateId: item.templateId }
    : {
        accountId,
        name: item.name ?? "",
        ...(item.language ? { language: item.language } : {}),
      };
  const updated = await tx.messageTemplate.updateMany({
    where,
    data: { status: item.status.toUpperCase() },
  });
  return updated.count
    ? { status: "PROCESSED" }
    : { status: "IGNORED", note: "Unknown template (next sync adds it)" };
}
