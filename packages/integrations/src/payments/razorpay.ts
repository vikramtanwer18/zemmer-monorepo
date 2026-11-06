import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  type CreateLinkInput,
  type CreateRefundInput,
  type CredentialCheck,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderLink,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderSubscription,
  type SubscriptionProvider,
} from "./types";

/**
 * Razorpay over its REST API (no SDK). Field names follow the current docs (checked 2026-11-05):
 * Payment Links, Refunds, Subscriptions and webhook payloads. **Not yet exercised against a live
 * Razorpay account** — tests use the fake provider, which emits the same payload shapes.
 */
const API = "https://api.razorpay.com/v1";

type Json = Record<string, unknown>;

const sec = (unix: unknown) =>
  typeof unix === "number" && unix > 0 ? new Date(unix * 1000) : null;

function toPayment(p: Json): ProviderPayment {
  return {
    id: String(p.id),
    amountMinor: Number(p.amount),
    currency: String(p.currency ?? "INR"),
    status: String(p.status) as ProviderPayment["status"],
    method: p.method ? String(p.method) : null,
    createdAt: sec(p.created_at) ?? new Date(),
    linkId: (p.payment_link_id as string | undefined) ?? null,
  };
}

export function toLink(l: Json): ProviderLink {
  const payments = Array.isArray(l.payments) ? (l.payments as Json[]) : [];
  return {
    id: String(l.id),
    referenceId: String(l.reference_id ?? ""),
    status: String(l.status) as ProviderLink["status"],
    amountMinor: Number(l.amount),
    amountPaidMinor: Number(l.amount_paid ?? 0),
    currency: String(l.currency ?? "INR"),
    shortUrl: String(l.short_url ?? ""),
    expiresAt: sec(l.expire_by),
    payments: payments
      .filter((p) => !p.status || p.status === "captured")
      .map((p) => ({
        id: String(p.payment_id ?? p.id),
        amountMinor: Number(p.amount),
        method: p.method ? String(p.method) : null,
        createdAt: sec(p.created_at) ?? new Date(),
      })),
  };
}

function toRefund(r: Json): ProviderRefund {
  return {
    id: String(r.id),
    paymentId: String(r.payment_id),
    amountMinor: Number(r.amount),
    status: String(r.status) as ProviderRefund["status"],
    receipt: r.receipt ? String(r.receipt) : null,
  };
}

function toSubscription(s: Json): ProviderSubscription {
  const notes =
    s.notes && typeof s.notes === "object" && !Array.isArray(s.notes)
      ? (s.notes as Record<string, string>)
      : {};
  return {
    id: String(s.id),
    planId: String(s.plan_id),
    status: String(s.status) as ProviderSubscription["status"],
    currentStart: sec(s.current_start),
    currentEnd: sec(s.current_end),
    chargeAt: sec(s.charge_at),
    paidCount: Number(s.paid_count ?? 0),
    notes,
    shortUrl: (s.short_url as string | undefined) ?? null,
  };
}

/** HMAC-SHA256 of the raw body with the webhook secret, compared in constant time. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature.toLowerCase()),
  );
}

export function signWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Turns a Razorpay webhook body into a NormalizedEvent. The event id comes from the
 * `x-razorpay-event-id` header (Razorpay's dedup key); unknown events are "ignored", not errors.
 */
export function parseRazorpayWebhook(
  rawBody: string,
  eventIdHeader: string | null,
): NormalizedEvent {
  const body = JSON.parse(rawBody) as Json;
  const event = String(body.event ?? "");
  const payload = (body.payload ?? {}) as Record<
    string,
    { entity?: Json } | undefined
  >;
  // Without the header (old replays), fall back to a stable id from the content.
  const eventId =
    eventIdHeader ||
    `${event}:${createHmac("sha256", "id").update(rawBody).digest("hex").slice(0, 32)}`;
  const entity = (key: string) => payload[key]?.entity;
  const [group, action] = event.split(".") as [string, string];
  if (group === "payment_link" && entity("payment_link")) {
    const link = entity("payment_link")!;
    if (["paid", "partially_paid", "cancelled", "expired"].includes(action))
      return {
        kind: "link",
        eventId,
        type: action as "paid",
        linkId: String(link.id),
        referenceId: link.reference_id ? String(link.reference_id) : null,
        payment: entity("payment") ? toPayment(entity("payment")!) : null,
      };
  }
  if (
    group === "payment" &&
    entity("payment") &&
    ["captured", "failed"].includes(action)
  )
    return {
      kind: "payment",
      eventId,
      type: action as "captured",
      payment: toPayment(entity("payment")!),
    };
  if (
    group === "refund" &&
    entity("refund") &&
    ["created", "processed", "failed"].includes(action)
  )
    return {
      kind: "refund",
      eventId,
      type: action as "processed",
      refund: toRefund(entity("refund")!),
    };
  if (group === "subscription" && entity("subscription"))
    return {
      kind: "subscription",
      eventId,
      type: action as "charged",
      subscription: toSubscription(entity("subscription")!),
      payment: entity("payment") ? toPayment(entity("payment")!) : null,
    };
  return { kind: "ignored", eventId, type: event };
}

class RazorpayClient {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T = Json>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) {
      const error = (json.error ?? {}) as Json;
      // Never include credentials or request bodies in errors (they may be logged).
      throw new ProviderError(
        String(error.description ?? `Razorpay returned ${res.status}`),
        res.status,
        error.code ? String(error.code) : null,
      );
    }
    return json as T;
  }

  async verify(): Promise<CredentialCheck> {
    try {
      await this.call("GET", "/payments?count=1");
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401)
        return { ok: false, reason: "Razorpay rejected the key id or secret." };
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "Couldn't reach Razorpay.",
      };
    }
  }
}

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = "RAZORPAY" as const;
  private readonly client: RazorpayClient;

  constructor(keyId: string, keySecret: string, fetchImpl?: typeof fetch) {
    this.client = new RazorpayClient(keyId, keySecret, fetchImpl);
  }

  verifyCredentials() {
    return this.client.verify();
  }

  async createPaymentLink(input: CreateLinkInput): Promise<ProviderLink> {
    const body: Json = {
      amount: input.amountMinor,
      currency: input.currency,
      accept_partial: input.acceptPartial,
      reference_id: input.referenceId,
      description: input.description.slice(0, 2048),
      customer: {
        name: input.customer.name,
        ...(input.customer.email ? { email: input.customer.email } : {}),
        ...(input.customer.contact ? { contact: input.customer.contact } : {}),
      },
      // We send our own emails/notifications (consent rules apply).
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: input.notes ?? {},
    };
    if (input.acceptPartial)
      body.first_min_partial_amount = Math.max(
        input.minPartialMinor ?? 100,
        100,
      );
    if (input.expiresAt)
      body.expire_by = Math.floor(input.expiresAt.getTime() / 1000);
    if (input.callbackUrl) {
      body.callback_url = input.callbackUrl;
      body.callback_method = "get";
    }
    return toLink(await this.client.call("POST", "/payment_links", body));
  }

  async fetchPaymentLink(id: string) {
    return toLink(
      await this.client.call("GET", `/payment_links/${encodeURIComponent(id)}`),
    );
  }

  async cancelPaymentLink(id: string) {
    return toLink(
      await this.client.call(
        "POST",
        `/payment_links/${encodeURIComponent(id)}/cancel`,
      ),
    );
  }

  async fetchPayment(id: string) {
    return toPayment(
      await this.client.call("GET", `/payments/${encodeURIComponent(id)}`),
    );
  }

  async createRefund(input: CreateRefundInput) {
    return toRefund(
      await this.client.call(
        "POST",
        `/payments/${encodeURIComponent(input.paymentId)}/refund`,
        {
          amount: input.amountMinor,
          receipt: input.receipt,
          notes: input.notes ?? {},
        },
      ),
    );
  }

  async fetchRefund(paymentId: string, refundId: string) {
    return toRefund(
      await this.client.call(
        "GET",
        `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
      ),
    );
  }
}

export class RazorpaySubscriptionProvider implements SubscriptionProvider {
  readonly name = "RAZORPAY" as const;
  private readonly client: RazorpayClient;

  constructor(keyId: string, keySecret: string, fetchImpl?: typeof fetch) {
    this.client = new RazorpayClient(keyId, keySecret, fetchImpl);
  }

  verifyCredentials() {
    return this.client.verify();
  }

  async createPlan(input: {
    period: "monthly" | "yearly";
    interval: number;
    name: string;
    amountMinor: number;
    currency: string;
  }) {
    const plan = await this.client.call("POST", "/plans", {
      period: input.period,
      interval: input.interval,
      item: {
        name: input.name,
        amount: input.amountMinor,
        currency: input.currency,
      },
    });
    return { id: String(plan.id) };
  }

  async createSubscription(input: {
    planId: string;
    totalCount: number;
    notes: Record<string, string>;
    customerNotify: boolean;
  }) {
    const sub = await this.client.call("POST", "/subscriptions", {
      plan_id: input.planId,
      total_count: input.totalCount,
      customer_notify: input.customerNotify,
      notes: input.notes,
    });
    const s = toSubscription(sub);
    return { ...s, shortUrl: s.shortUrl ?? null };
  }

  async fetchSubscription(id: string) {
    return toSubscription(
      await this.client.call("GET", `/subscriptions/${encodeURIComponent(id)}`),
    );
  }

  async cancelSubscription(id: string, atCycleEnd: boolean) {
    return toSubscription(
      await this.client.call(
        "POST",
        `/subscriptions/${encodeURIComponent(id)}/cancel`,
        {
          cancel_at_cycle_end: atCycleEnd,
        },
      ),
    );
  }

  /** PATCH /subscriptions/{id} — field names from the docs' response section; verify live. */
  async changePlan(id: string, planId: string, when: "now" | "cycle_end") {
    return toSubscription(
      await this.client.call(
        "PATCH",
        `/subscriptions/${encodeURIComponent(id)}`,
        {
          plan_id: planId,
          schedule_change_at: when,
        },
      ),
    );
  }
}
