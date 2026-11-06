import { withTenant, type Prisma, type TenantTransaction } from "@gym/db";
import { WhatsAppError } from "@gym/integrations/whatsapp";
import { isFeatureEnabled, quotaLimit } from "../entitlements";
import { entitlementsFor, nowOf, type CoreDeps } from "../tenancy/deps";
import { startOfDayUtc, todayIn } from "../time/dates";
import { clientOf, credentialsOf, currentAccountTx } from "./accounts";
import { consentForTx, isSuppressedTx } from "./contacts";
import {
  evaluateSendGate,
  renderTemplateBody,
  templateParameters,
  toMetaPhone,
  type SendPurpose,
  type SkipReason,
} from "./rules";

/**
 * The WhatsApp send pipeline (M6 §3):
 *   queueMessageTx (in the caller's transaction, idempotent per key) → outbox "message.send"
 *   → worker → deliverMessage: gate re-checked now → provider → SENT, or retry / FAILED.
 * A message in SENDING is never sent again (the provider may have accepted it), so a crash
 * mid-send can lose a message but never duplicate one.
 */

export type QueueMessageInput = {
  toPhone: string;
  memberId?: string | null;
  leadId?: string | null;
  purpose: SendPurpose;
  /** e.g. "campaign:<recipientId>", "auto:<executionId>:<step>", "notif:<key>". */
  idempotencyKey: string;
  campaignId?: string | null;
  executionId?: string | null;
  createdById?: string | null;
} & (
  | {
      kind: "TEMPLATE";
      templateId: string;
      values: Record<string, string | number | null | undefined>;
    }
  | { kind: "TEXT"; body: string }
);

/** Opt-out/opt-in confirmations are the only sends allowed to a suppressed number. */
export const KEYWORD_REPLY_PREFIX = "keyword-reply:";

export type QueueResult =
  | { queued: true; id: string; created: boolean }
  | { queued: false; reason: "NO_ACCOUNT" | "NO_TEMPLATE" };

export async function queueMessageTx(
  tx: TenantTransaction,
  tenantId: string,
  input: QueueMessageInput,
): Promise<QueueResult> {
  const account = await currentAccountTx(tx);
  if (!account) return { queued: false, reason: "NO_ACCOUNT" };
  const existing = await tx.outboundMessage.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true },
  });
  if (existing) return { queued: true, id: existing.id, created: false };

  let data: Prisma.OutboundMessageCreateManyInput;
  const common = {
    tenantId,
    accountId: account.id,
    idempotencyKey: input.idempotencyKey,
    toPhone: input.toPhone,
    memberId: input.memberId ?? null,
    leadId: input.memberId ? null : (input.leadId ?? null),
    purpose: input.purpose,
    campaignId: input.campaignId ?? null,
    executionId: input.executionId ?? null,
    createdById: input.createdById ?? null,
  };
  const conversation = await tx.conversation.findUnique({
    where: {
      tenantId_accountId_phone: {
        tenantId,
        accountId: account.id,
        phone: input.toPhone,
      },
    },
    select: { id: true },
  });
  if (input.kind === "TEMPLATE") {
    const template = await tx.messageTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (!template || template.accountId !== account.id)
      return { queued: false, reason: "NO_TEMPLATE" };
    const params = templateParameters(
      template.variables,
      template.parameterFormat,
      input.values,
    );
    data = {
      ...common,
      conversationId: conversation?.id ?? null,
      kind: "TEMPLATE",
      templateId: template.id,
      templateName: template.name,
      language: template.language,
      variables: params as Prisma.InputJsonValue,
      body: renderTemplateBody(template.bodyText, params),
      category: template.category,
    };
  } else {
    data = {
      ...common,
      conversationId: conversation?.id ?? null,
      kind: "TEXT",
      body: input.body.slice(0, 4096),
      category: "OTHER",
    };
  }
  // ON CONFLICT DO NOTHING: two concurrent producers of the same key create one row.
  const created = await tx.outboundMessage.createMany({
    data: [data],
    skipDuplicates: true,
  });
  const row = await tx.outboundMessage.findUniqueOrThrow({
    where: {
      tenantId_idempotencyKey: {
        tenantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true },
  });
  if (created.count === 1)
    await tx.outbox.create({
      data: {
        tenantId,
        topic: "message.send",
        payload: { outboundId: row.id },
      },
    });
  return { queued: true, id: row.id, created: created.count === 1 };
}

export type DeliverResult =
  | { status: "SENT"; providerMessageId: string }
  | { status: "SKIPPED"; reason: SkipReason }
  | { status: "FAILED"; code: string }
  | { status: "RETRY"; code: string }
  | { status: "NOOP"; current: string };

export class RetryableSendError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RetryableSendError";
  }
}

const SENT_STATES = ["SENT", "DELIVERED", "READ"] as const;

async function syncRecipient(
  tx: TenantTransaction,
  outboundId: string,
  status: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED",
  skipReason?: string | null,
) {
  await tx.campaignRecipient.updateMany({
    where: { outboundMessageId: outboundId },
    data: { status, ...(skipReason !== undefined ? { skipReason } : {}) },
  });
}

/**
 * Worker side, one message. Re-checks plan, account, suppression, consent, the 24-hour window,
 * the template's approval and the daily cap NOW. `finalAttempt` turns a retryable error into
 * FAILED; otherwise the row goes back to QUEUED and RetryableSendError is thrown (job retries
 * with backoff).
 */
export async function deliverMessage(
  deps: CoreDeps,
  tenantId: string,
  outboundId: string,
  options: { finalAttempt: boolean },
): Promise<DeliverResult> {
  const now = nowOf(deps);
  const ent = await entitlementsFor(deps, tenantId);
  type Claimed = {
    row: NonNullable<
      Awaited<ReturnType<TenantTransaction["outboundMessage"]["findUnique"]>>
    >;
    account: NonNullable<
      Awaited<ReturnType<TenantTransaction["whatsAppAccount"]["findUnique"]>>
    >;
    template: Awaited<
      ReturnType<TenantTransaction["messageTemplate"]["findUnique"]>
    >;
  };
  const claim = await withTenant(
    deps.db,
    tenantId,
    async (tx): Promise<{ done: DeliverResult } | Claimed> => {
      // Two deliveries of the same job wait for each other here, so the second one always sees the
      // first one's outcome (and never re-judges a message that was just sent).
      await tx.$queryRaw`SELECT id FROM app.outbound_message WHERE id = ${outboundId}::uuid FOR UPDATE`;
      const row = await tx.outboundMessage.findUnique({
        where: { id: outboundId },
      });
      if (!row)
        return {
          done: { status: "NOOP", current: "MISSING" } as DeliverResult,
        };
      if (row.status !== "QUEUED")
        return {
          done: { status: "NOOP", current: row.status } as DeliverResult,
        };
      const [account, template, settings, conversation, tenant] = [
        await tx.whatsAppAccount.findUnique({ where: { id: row.accountId } }),
        row.templateId
          ? await tx.messageTemplate.findUnique({
              where: { id: row.templateId },
            })
          : null,
        await tx.tenantSettings.findUnique({
          where: { tenantId },
          select: { marketingDailyCap: true },
        }),
        await tx.conversation.findUnique({
          where: {
            tenantId_accountId_phone: {
              tenantId,
              accountId: row.accountId,
              phone: row.toPhone,
            },
          },
          select: { id: true, lastInboundAt: true },
        }),
        await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { timezone: true },
        }),
      ];
      const marketing = row.category === "MARKETING" && row.purpose !== "TEST";
      const [marketingSent, monthlyUsed] = [
        marketing
          ? await tx.outboundMessage.count({
              where: {
                id: { not: row.id },
                toPhone: row.toPhone,
                category: "MARKETING",
                purpose: { in: ["CAMPAIGN", "AUTOMATION"] },
                status: { in: [...SENT_STATES] },
                sentAt: { gte: new Date(now.getTime() - 86_400_000) },
              },
            })
          : 0,
        await tx.outboundMessage.count({
          where: {
            status: { in: [...SENT_STATES] },
            sentAt: {
              gte: startOfDayUtc(
                `${todayIn(tenant.timezone, now).slice(0, 7)}-01`,
                tenant.timezone,
              ),
            },
          },
        }),
      ];
      const bypass =
        row.purpose === "INBOX" &&
        row.idempotencyKey.startsWith(KEYWORD_REPLY_PREFIX);
      const gate = evaluateSendGate({
        planAllows: isFeatureEnabled(ent, "whatsapp.enabled"),
        accountStatus: account?.status ?? null,
        kind: row.kind,
        purpose: row.purpose,
        category: row.category,
        templateStatus: template?.status ?? null,
        suppressed: await isSuppressedTx(tx, row.toPhone),
        bypassSuppression: bypass,
        consent: await consentForTx(tx, {
          memberId: row.memberId,
          leadId: row.leadId,
        }),
        lastInboundAt: conversation?.lastInboundAt ?? null,
        now,
        marketingSentLast24h: marketingSent,
        marketingDailyCap: settings?.marketingDailyCap ?? 1,
        monthlyUsed,
        monthlyLimit: quotaLimit(ent, "whatsapp.monthly_messages"),
      });
      if (!gate.ok) {
        await tx.outboundMessage.updateMany({
          where: { id: row.id, status: "QUEUED" },
          data: { status: "SKIPPED", skipReason: gate.reason },
        });
        await syncRecipient(tx, row.id, "SKIPPED", gate.reason);
        return {
          done: { status: "SKIPPED", reason: gate.reason } as DeliverResult,
        };
      }
      // Claim: from here on the row is never sent again by another attempt.
      const claimed = await tx.outboundMessage.updateMany({
        where: { id: row.id, status: "QUEUED" },
        data: {
          status: "SENDING",
          attempts: { increment: 1 },
          conversationId: row.conversationId ?? conversation?.id ?? null,
        },
      });
      if (claimed.count === 0)
        return { done: { status: "NOOP", current: "RACED" } as DeliverResult };
      return { row, account: account!, template } satisfies Claimed;
    },
  );
  if ("done" in claim) return claim.done;

  const { row, account, template } = claim;
  const client = clientOf(deps, account);
  try {
    const creds = credentialsOf(deps, account);
    const sent =
      row.kind === "TEMPLATE"
        ? await client.sendTemplate(creds, {
            to: toMetaPhone(row.toPhone),
            name: template!.name,
            language: template!.language,
            parameterFormat:
              template!.parameterFormat === "NAMED" ? "NAMED" : "POSITIONAL",
            parameters: (row.variables ?? []) as
              string[] | Record<string, string>,
          })
        : await client.sendText(creds, {
            to: toMetaPhone(row.toPhone),
            body: row.body ?? "",
          });
    await withTenant(deps.db, tenantId, async (tx) => {
      await tx.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          providerMessageId: sent.messageId,
          sentAt: nowOf(deps),
          errorCode: null,
          errorMessage: null,
        },
      });
      await syncRecipient(tx, row.id, "SENT");
      if (row.conversationId)
        await tx.conversation.update({
          where: { id: row.conversationId },
          data: { lastMessageAt: nowOf(deps) },
        });
    });
    return { status: "SENT", providerMessageId: sent.messageId };
  } catch (err) {
    const e =
      err instanceof WhatsAppError
        ? err
        : new WhatsAppError("Unexpected error while sending.", "UNKNOWN", true);
    const retry = e.retryable && !options.finalAttempt;
    await withTenant(deps.db, tenantId, async (tx) => {
      await tx.outboundMessage.update({
        where: { id: row.id },
        data: retry
          ? {
              status: "QUEUED",
              errorCode: e.code,
              errorMessage: e.message.slice(0, 500),
            }
          : {
              status: "FAILED",
              failedAt: nowOf(deps),
              errorCode: e.code,
              errorMessage: e.message.slice(0, 500),
            },
      });
      if (!retry)
        await syncRecipient(tx, row.id, "FAILED", e.message.slice(0, 200));
      // 131050: the person stopped marketing messages in WhatsApp itself; honour it here too.
      if (e.code === "131050" && (row.memberId || row.leadId))
        await tx.contactConsent.create({
          data: {
            tenantId,
            memberId: row.memberId,
            leadId: row.memberId ? null : row.leadId,
            channel: "WHATSAPP",
            purpose: "MARKETING",
            status: "REVOKED",
            method: "INBOUND_KEYWORD",
            evidence:
              "WhatsApp reported the user stopped marketing messages (131050).",
          },
        });
    });
    if (retry) throw new RetryableSendError(e.message, e.code);
    return { status: "FAILED", code: e.code };
  }
}

/** Rows stuck in SENDING (worker died mid-call): mark FAILED, never resend (could duplicate). */
export async function failStaleSendsTx(tx: TenantTransaction, now: Date) {
  const stale = await tx.outboundMessage.findMany({
    where: {
      status: "SENDING",
      updatedAt: { lt: new Date(now.getTime() - 15 * 60_000) },
    },
    select: { id: true },
    take: 500,
  });
  for (const s of stale) {
    await tx.outboundMessage.update({
      where: { id: s.id },
      data: {
        status: "FAILED",
        failedAt: now,
        errorCode: "UNKNOWN_STATE",
        errorMessage:
          "The send was interrupted; not retried to avoid a duplicate message.",
      },
    });
    await syncRecipient(tx, s.id, "FAILED", "Interrupted");
  }
  return stale.length;
}
