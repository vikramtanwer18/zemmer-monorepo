import { toLink } from "./razorpay";
import {
  ProviderError,
  type CreateLinkInput,
  type CreateRefundInput,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderSubscription,
  type SubscriptionProvider,
} from "./types";

/**
 * A stand-in for Razorpay in tests and local development: no network, no real money. It keeps
 * its state in a small key-value store (memory, or Redis so the web app, the worker and the test
 * runner share it) and produces webhook bodies in Razorpay's exact shape, which the caller signs
 * and delivers — once, several times, or out of order. Never enabled in production.
 */
export interface FakeStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  incr(key: string): Promise<number>;
}

export function memoryFakeStore(): FakeStore {
  const map = new Map<string, string>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async incr(k) {
      const n = Number(map.get(k) ?? 0) + 1;
      map.set(k, String(n));
      return n;
    },
  };
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
  ): Promise<unknown>;
  incr(key: string): Promise<number>;
};

/** Shared across processes; entries expire after 30 days. */
export function redisFakeStore(redis: RedisLike): FakeStore {
  const k = (key: string) => `gym:fakepay:${key}`;
  return {
    get: (key) => redis.get(k(key)),
    async set(key, value) {
      await redis.set(k(key), value, "EX", 30 * 86_400);
    },
    incr: (key) => redis.incr(k(key)),
  };
}

/** A webhook ready to sign and deliver. */
export type FakeWebhook = { eventId: string; event: string; rawBody: string };

type Json = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);

export class FakePaymentProvider implements PaymentProvider {
  readonly name = "FAKE" as const;

  /**
   * @param account   the integration's key id: separates gyms inside one store.
   * @param keySecret "wrong-secret" fails verification (to test the error path).
   * @param checkoutBase where the fake checkout page lives, e.g. http://localhost:3000/dev/fake-pay
   */
  constructor(
    private readonly store: FakeStore,
    private readonly account: string,
    private readonly keySecret: string,
    private readonly checkoutBase = "http://localhost:3000/dev/fake-pay",
  ) {}

  private key(kind: string, id: string) {
    return `${this.account}:${kind}:${id}`;
  }

  private async nextId(prefix: string) {
    return `${prefix}_fake${String(await this.store.incr(`seq:${prefix}`)).padStart(6, "0")}`;
  }

  private async load(kind: string, id: string): Promise<Json> {
    const raw = await this.store.get(this.key(kind, id));
    if (!raw)
      throw new ProviderError(
        `The id provided does not exist`,
        400,
        "BAD_REQUEST_ERROR",
      );
    return JSON.parse(raw) as Json;
  }

  private async save(kind: string, id: string, value: Json) {
    await this.store.set(this.key(kind, id), JSON.stringify(value));
  }

  async verifyCredentials() {
    return this.keySecret === "wrong-secret"
      ? ({
          ok: false,
          reason: "Razorpay rejected the key id or secret.",
        } as const)
      : ({ ok: true } as const);
  }

  async createPaymentLink(input: CreateLinkInput) {
    const refKey = this.key("ref", input.referenceId);
    if (await this.store.get(refKey))
      throw new ProviderError(
        "payment link with given reference_id already exists",
        400,
        "BAD_REQUEST_ERROR",
      );
    const id = await this.nextId("plink");
    const link: Json = {
      id,
      reference_id: input.referenceId,
      status: "created",
      amount: input.amountMinor,
      amount_paid: 0,
      currency: input.currency,
      accept_partial: input.acceptPartial,
      first_min_partial_amount: input.minPartialMinor ?? 100,
      short_url: `${this.checkoutBase}/${encodeURIComponent(this.account)}/${id}`,
      expire_by: input.expiresAt
        ? Math.floor(input.expiresAt.getTime() / 1000)
        : 0,
      description: input.description,
      callback_url: input.callbackUrl ?? null,
      notes: input.notes ?? {},
      payments: [],
      created_at: now(),
    };
    await this.store.set(refKey, id);
    await this.save("link", id, link);
    return toLink(link);
  }

  async fetchPaymentLink(id: string) {
    return toLink(await this.load("link", id));
  }

  /** Raw link (for the fake checkout page: amount due, callback URL). */
  async rawLink(id: string) {
    return this.load("link", id);
  }

  async cancelPaymentLink(id: string) {
    const link = await this.load("link", id);
    if (link.status === "paid")
      throw new ProviderError(
        "Payment link already paid",
        400,
        "BAD_REQUEST_ERROR",
      );
    link.status = "cancelled";
    link.cancelled_at = now();
    await this.save("link", id, link);
    return toLink(link);
  }

  async fetchPayment(id: string): Promise<ProviderPayment> {
    const p = await this.load("payment", id);
    return {
      id: String(p.id),
      amountMinor: Number(p.amount),
      currency: String(p.currency),
      status: p.status as ProviderPayment["status"],
      method: String(p.method),
      createdAt: new Date(Number(p.created_at) * 1000),
      linkId: (p.payment_link_id as string) ?? null,
    };
  }

  /**
   * The customer pays `amountMinor` (default: what's left) on the fake checkout.
   * Returns the webhook Razorpay would send (payment_link.partially_paid or .paid).
   */
  async pay(
    linkId: string,
    amountMinor?: number,
    method = "upi",
  ): Promise<{ webhook: FakeWebhook; paymentId: string }> {
    const link = await this.load("link", linkId);
    if (
      link.status === "paid" ||
      link.status === "cancelled" ||
      link.status === "expired"
    )
      throw new ProviderError(
        `Payment link is ${String(link.status)}`,
        400,
        "BAD_REQUEST_ERROR",
      );
    const due = Number(link.amount) - Number(link.amount_paid);
    const amount = amountMinor ?? due;
    if (amount <= 0 || amount > due)
      throw new ProviderError("Invalid amount", 400, "BAD_REQUEST_ERROR");
    if (amount < due && !link.accept_partial)
      throw new ProviderError(
        "Partial payments are not allowed",
        400,
        "BAD_REQUEST_ERROR",
      );
    const paymentId = await this.nextId("pay");
    const payment: Json = {
      id: paymentId,
      entity: "payment",
      amount,
      currency: link.currency,
      status: "captured",
      method,
      captured: true,
      payment_link_id: linkId,
      order_id: `order_${linkId}`,
      created_at: now(),
    };
    await this.save("payment", paymentId, payment);
    link.amount_paid = Number(link.amount_paid) + amount;
    link.status =
      Number(link.amount_paid) >= Number(link.amount)
        ? "paid"
        : "partially_paid";
    (link.payments as Json[]).push({
      payment_id: paymentId,
      amount,
      method,
      status: "captured",
      created_at: payment.created_at,
    });
    await this.save("link", linkId, link);
    const webhook = await this.webhook(`payment_link.${String(link.status)}`, {
      payment_link: { entity: { ...link, payments: undefined } },
      payment: { entity: payment },
      order: {
        entity: {
          id: payment.order_id,
          amount: link.amount,
          amount_paid: link.amount_paid,
          amount_due: Number(link.amount) - Number(link.amount_paid),
          status: link.status === "paid" ? "paid" : "attempted",
          receipt: link.reference_id,
        },
      },
    });
    return { webhook, paymentId };
  }

  async expire(linkId: string): Promise<FakeWebhook> {
    const link = await this.load("link", linkId);
    link.status = "expired";
    link.expired_at = now();
    await this.save("link", linkId, link);
    return this.webhook("payment_link.expired", {
      payment_link: { entity: { ...link, payments: undefined } },
    });
  }

  async createRefund(input: CreateRefundInput): Promise<ProviderRefund> {
    const payment = await this.load("payment", input.paymentId);
    const receiptKey = this.key(
      "refund-receipt",
      `${input.paymentId}:${input.receipt}`,
    );
    const existing = await this.store.get(receiptKey);
    if (existing)
      throw new ProviderError(
        "Duplicate receipt found for this refund request",
        400,
        "BAD_REQUEST_ERROR",
      );
    const refunded = Number(payment.amount_refunded ?? 0);
    if (
      input.amountMinor <= 0 ||
      refunded + input.amountMinor > Number(payment.amount)
    )
      throw new ProviderError(
        "The refund amount provided is greater than amount captured",
        400,
        "BAD_REQUEST_ERROR",
      );
    const id = await this.nextId("rfnd");
    const refund: Json = {
      id,
      entity: "refund",
      payment_id: input.paymentId,
      amount: input.amountMinor,
      currency: payment.currency,
      status: "pending",
      receipt: input.receipt,
      notes: input.notes ?? {},
      speed_requested: "normal",
      created_at: now(),
    };
    payment.amount_refunded = refunded + input.amountMinor;
    await this.save("payment", input.paymentId, payment);
    await this.save("refund", id, refund);
    await this.store.set(receiptKey, id);
    return {
      id,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      status: "pending",
      receipt: input.receipt,
    };
  }

  async fetchRefund(
    paymentId: string,
    refundId: string,
  ): Promise<ProviderRefund> {
    const r = await this.load("refund", refundId);
    if (r.payment_id !== paymentId)
      throw new ProviderError(
        "The id provided does not exist",
        400,
        "BAD_REQUEST_ERROR",
      );
    return {
      id: String(r.id),
      paymentId: String(r.payment_id),
      amountMinor: Number(r.amount),
      status: r.status as ProviderRefund["status"],
      receipt: (r.receipt as string) ?? null,
    };
  }

  /** The bank finishes (or fails) the refund: refund.processed / refund.failed. */
  async settleRefund(refundId: string, outcome: "processed" | "failed") {
    const refund = await this.load("refund", refundId);
    refund.status = outcome;
    if (outcome === "failed") {
      const payment = await this.load("payment", String(refund.payment_id));
      payment.amount_refunded =
        Number(payment.amount_refunded ?? 0) - Number(refund.amount);
      await this.save("payment", String(refund.payment_id), payment);
    }
    await this.save("refund", refundId, refund);
    return this.webhook(`refund.${outcome}`, { refund: { entity: refund } });
  }

  private async webhook(event: string, payload: Json): Promise<FakeWebhook> {
    const eventId = await this.nextId("evt");
    const body = {
      entity: "event",
      account_id: `acc_${this.account}`,
      event,
      contains: Object.keys(payload),
      payload,
      created_at: now(),
    };
    return { eventId, event, rawBody: JSON.stringify(body) };
  }
}

/** Fake platform subscriptions (SaaS billing tests and local demos). */
export class FakeSubscriptionProvider implements SubscriptionProvider {
  readonly name = "FAKE" as const;
  private readonly links: FakePaymentProvider;

  constructor(
    private readonly store: FakeStore,
    private readonly checkoutBase = "http://localhost:3001/dev/fake-subscribe",
  ) {
    this.links = new FakePaymentProvider(store, "platform", "ok", checkoutBase);
  }

  private async load(id: string) {
    const raw = await this.store.get(`platform:sub:${id}`);
    if (!raw)
      throw new ProviderError(
        "The id provided does not exist",
        400,
        "BAD_REQUEST_ERROR",
      );
    return JSON.parse(raw) as Json;
  }

  private async save(id: string, s: Json) {
    await this.store.set(`platform:sub:${id}`, JSON.stringify(s));
  }

  private view(s: Json): ProviderSubscription {
    const d = (v: unknown) =>
      typeof v === "number" && v > 0 ? new Date(v * 1000) : null;
    return {
      id: String(s.id),
      planId: String(s.plan_id),
      status: s.status as ProviderSubscription["status"],
      currentStart: d(s.current_start),
      currentEnd: d(s.current_end),
      chargeAt: d(s.charge_at),
      paidCount: Number(s.paid_count ?? 0),
      notes: (s.notes as Record<string, string>) ?? {},
      shortUrl: (s.short_url as string) ?? null,
    };
  }

  async verifyCredentials() {
    return { ok: true } as const;
  }

  async createPlan(input: {
    period: "monthly" | "yearly";
    interval: number;
    name: string;
    amountMinor: number;
    currency: string;
  }) {
    const id = `plan_fake${String(await this.store.incr("seq:plan")).padStart(6, "0")}`;
    await this.store.set(`platform:plan:${id}`, JSON.stringify(input));
    return { id };
  }

  async createSubscription(input: {
    planId: string;
    totalCount: number;
    notes: Record<string, string>;
    customerNotify: boolean;
  }) {
    const id = `sub_fake${String(await this.store.incr("seq:sub")).padStart(6, "0")}`;
    const s: Json = {
      id,
      plan_id: input.planId,
      status: "created",
      total_count: input.totalCount,
      paid_count: 0,
      notes: input.notes,
      short_url: `${this.checkoutBase}/${id}`,
    };
    await this.save(id, s);
    const v = this.view(s);
    return { ...v, shortUrl: v.shortUrl ?? null };
  }

  async fetchSubscription(id: string) {
    return this.view(await this.load(id));
  }

  async cancelSubscription(id: string, atCycleEnd: boolean) {
    const s = await this.load(id);
    if (!atCycleEnd) s.status = "cancelled";
    s.cancel_at_cycle_end = atCycleEnd;
    await this.save(id, s);
    return this.view(s);
  }

  async changePlan(id: string, planId: string, when: "now" | "cycle_end") {
    const s = await this.load(id);
    if (when === "now") s.plan_id = planId;
    else s.scheduled_plan_id = planId;
    await this.save(id, s);
    return this.view(s);
  }

  /**
   * Drives the fake through Razorpay's lifecycle and returns the webhooks it would send:
   * "charge" (activated on first charge + charged), "fail" (pending), "halt" (halted),
   * "cancel" (cancelled).
   */
  async simulate(
    id: string,
    what: "charge" | "fail" | "halt" | "cancel",
    periodDays = 30,
  ): Promise<FakeWebhook[]> {
    const s = await this.load(id);
    const plan = JSON.parse(
      (await this.store.get(`platform:plan:${String(s.plan_id)}`)) ?? "{}",
    ) as Json;
    const out: FakeWebhook[] = [];
    const ts = now();
    const event = async (name: string, payment?: Json) => {
      const eventId = `evt_fake${String(await this.store.incr("seq:evt")).padStart(6, "0")}`;
      const payload: Json = { subscription: { entity: { ...s } } };
      if (payment) payload.payment = { entity: payment };
      out.push({
        eventId,
        event: name,
        rawBody: JSON.stringify({
          entity: "event",
          account_id: "acc_platform",
          event: name,
          contains: Object.keys(payload),
          payload,
          created_at: ts,
        }),
      });
    };
    if (what === "charge") {
      const first = s.status === "created" || s.status === "authenticated";
      const start =
        Number(s.current_end ?? 0) > ts ? Number(s.current_end) : ts;
      s.status = "active";
      s.current_start = start;
      s.current_end = start + periodDays * 86_400;
      s.charge_at = s.current_end;
      s.paid_count = Number(s.paid_count ?? 0) + 1;
      await this.save(id, s);
      const paymentId = `pay_fake${String(await this.store.incr("seq:pay")).padStart(6, "0")}`;
      const payment = {
        id: paymentId,
        entity: "payment",
        amount: Number(plan.amountMinor ?? 0),
        currency: String(plan.currency ?? "INR"),
        status: "captured",
        method: "card",
        created_at: ts,
      };
      if (first) await event("subscription.activated");
      await event("subscription.charged", payment);
    } else if (what === "fail") {
      s.status = "pending";
      await this.save(id, s);
      await event("subscription.pending");
    } else if (what === "halt") {
      s.status = "halted";
      await this.save(id, s);
      await event("subscription.halted");
    } else {
      s.status = "cancelled";
      await this.save(id, s);
      await event("subscription.cancelled");
    }
    return out;
  }

  /** Exposed for symmetry with gym payments (unused by SaaS billing). */
  get paymentLinks() {
    return this.links;
  }
}
