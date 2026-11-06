import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, TenantTransaction } from "@gym/db";
import { withTenant } from "@gym/db";
import { z } from "zod";

/**
 * Domain events (M5 §11). Emitted inside the transaction that made the change, as an outbox row
 * (topic "event", row id = event id), so an event exists if and only if the change committed.
 * The outbox relay turns each into an `events.dispatch` job; every registered handler then runs
 * at most once per event (EventConsumption row written in the handler's own transaction).
 *
 * The event names and data shapes are a contract for M6 automations: add fields, don't rename.
 */
export const EVENT_SCHEMAS = {
  "lead.created": z.object({
    leadId: z.uuid(),
    branchId: z.uuid(),
    via: z.enum(["STAFF", "FORM", "API", "IMPORT"]),
    sourceId: z.uuid().nullable(),
    campaignId: z.uuid().nullable(),
    ownerUserId: z.uuid().nullable(),
  }),
  "lead.stage_changed": z.object({
    leadId: z.uuid(),
    fromStageId: z.uuid(),
    toStageId: z.uuid(),
    fromCategory: z.string(),
    toCategory: z.string(),
  }),
  "lead.assigned": z.object({
    leadId: z.uuid(),
    fromUserId: z.uuid().nullable(),
    toUserId: z.uuid().nullable(),
    automatic: z.boolean(),
  }),
  "lead.uncontacted_sla_breached": z.object({
    leadId: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    minutes: z.number().int(),
  }),
  "lead.lost": z.object({ leadId: z.uuid(), lostReasonId: z.uuid() }),
  "lead.converted": z.object({
    leadId: z.uuid(),
    memberId: z.uuid(),
    membershipId: z.uuid(),
    campaignId: z.uuid().nullable(),
  }),
  "trial.booked": z.object({
    trialId: z.uuid(),
    leadId: z.uuid(),
    startsAt: z.string(),
    classSessionId: z.uuid().nullable(),
  }),
  "trial.attended": z.object({ trialId: z.uuid(), leadId: z.uuid() }),
  "trial.no_show": z.object({ trialId: z.uuid(), leadId: z.uuid() }),
  "trial.cancelled": z.object({ trialId: z.uuid(), leadId: z.uuid() }),
  // --- M6 (automation triggers)
  "membership.activated": z.object({
    membershipId: z.uuid(),
    memberId: z.uuid(),
    planId: z.uuid(),
    branchId: z.uuid(),
    amountMinor: z.number().int(),
    renewal: z.boolean(),
  }),
  "class.booking_cancelled": z.object({
    bookingId: z.uuid(),
    memberId: z.uuid(),
    sessionId: z.uuid(),
    branchId: z.uuid(),
    late: z.boolean(),
  }),
  // --- M7
  "attendance.checked_in": z.object({
    attendanceId: z.uuid(),
    memberId: z.uuid(),
    branchId: z.uuid(),
    occurredAt: z.string(),
  }),
  "referral.converted": z.object({
    referralId: z.uuid(),
    referrerMemberId: z.uuid(),
    referredMemberId: z.uuid(),
    leadId: z.uuid().nullable(),
    points: z.number().int(),
  }),
  "retention.flagged": z.object({
    flagId: z.uuid(),
    kind: z.string(),
    memberId: z.uuid().nullable(),
    leadId: z.uuid().nullable(),
    branchId: z.uuid().nullable(),
  }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventData<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

export type DomainEvent<T extends EventType = EventType> = {
  eventId: string;
  type: T;
  occurredAt: string;
  data: EventData<T>;
};

/** Writes the event to the outbox in the caller's transaction. Returns the event id. */
export async function emitEvent<T extends EventType>(
  tx: TenantTransaction,
  tenantId: string,
  type: T,
  data: EventData<T>,
): Promise<string> {
  const parsed = EVENT_SCHEMAS[type].parse(data);
  const eventId = randomUUID();
  await tx.outbox.create({
    data: {
      id: eventId,
      tenantId,
      topic: "event",
      payload: {
        eventId,
        type,
        occurredAt: new Date().toISOString(),
        data: parsed,
      } as Prisma.InputJsonValue,
    },
  });
  return eventId;
}

export type EventHandler = {
  /** Stable name: it is the idempotency key with the event id. Never rename a live handler. */
  name: string;
  types: readonly EventType[];
  handle: (
    tx: TenantTransaction,
    tenantId: string,
    event: DomainEvent,
  ) => Promise<void>;
};

/**
 * Runs every matching handler once for this event. Each handler gets its own transaction that
 * first claims `(event, handler)`; a second delivery finds the claim and skips. A failing handler
 * rolls back its own claim and throws, so the job retries it (others are already recorded).
 */
export async function dispatchEvent(
  db: PrismaClient,
  tenantId: string,
  eventId: string,
  handlers: readonly EventHandler[],
): Promise<{ ran: string[]; skipped: string[] }> {
  const row = await withTenant(db, tenantId, (tx) =>
    tx.outbox.findUnique({ where: { id: eventId } }),
  );
  if (!row || row.topic !== "event")
    throw new Error(`Event ${eventId} not found`);
  const event = row.payload as unknown as DomainEvent;
  const ran: string[] = [];
  const skipped: string[] = [];
  let failure: unknown = null;
  for (const handler of handlers) {
    if (!handler.types.includes(event.type)) continue;
    try {
      const done = await withTenant(db, tenantId, async (tx) => {
        const claimed = await tx.eventConsumption.createMany({
          data: [{ tenantId, eventId, handler: handler.name }],
          skipDuplicates: true,
        });
        if (claimed.count === 0) return false;
        await handler.handle(tx, tenantId, event);
        return true;
      });
      (done ? ran : skipped).push(handler.name);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return { ran, skipped };
}
