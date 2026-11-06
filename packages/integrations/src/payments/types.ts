/**
 * Provider-independent payment types (D-10: Razorpay only in v1, behind this adapter).
 * Amounts are integer minor units (paise) everywhere.
 */

export type ProviderLinkStatus =
  "created" | "partially_paid" | "paid" | "expired" | "cancelled";

export type ProviderPayment = {
  id: string;
  amountMinor: number;
  currency: string;
  /** captured = money received. */
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method: string | null;
  createdAt: Date;
  linkId?: string | null;
};

export type ProviderLink = {
  id: string;
  referenceId: string;
  status: ProviderLinkStatus;
  amountMinor: number;
  amountPaidMinor: number;
  currency: string;
  shortUrl: string;
  expiresAt: Date | null;
  /** Captured payments only. */
  payments: {
    id: string;
    amountMinor: number;
    method: string | null;
    createdAt: Date;
  }[];
};

export type ProviderRefund = {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: "pending" | "processed" | "failed";
  receipt: string | null;
};

export type CreateLinkInput = {
  amountMinor: number;
  currency: string;
  /** Our unique id (≤ 40 chars). The provider refuses a second link with it. */
  referenceId: string;
  description: string;
  acceptPartial: boolean;
  minPartialMinor?: number;
  expiresAt?: Date;
  customer: { name: string; email?: string | null; contact?: string | null };
  callbackUrl?: string;
  notes?: Record<string, string>;
};

export type CreateRefundInput = {
  paymentId: string;
  amountMinor: number;
  /** Our unique id; Razorpay treats `receipt` as the idempotency key. */
  receipt: string;
  notes?: Record<string, string>;
};

/** Events we act on, in one shape whatever the provider. */
export type NormalizedEvent =
  | {
      kind: "link";
      eventId: string;
      type: "paid" | "partially_paid" | "cancelled" | "expired";
      linkId: string;
      referenceId: string | null;
      payment: ProviderPayment | null;
    }
  | {
      kind: "payment";
      eventId: string;
      type: "captured" | "failed";
      payment: ProviderPayment;
    }
  | {
      kind: "refund";
      eventId: string;
      type: "created" | "processed" | "failed";
      refund: ProviderRefund;
    }
  | {
      kind: "subscription";
      eventId: string;
      type:
        | "authenticated"
        | "activated"
        | "charged"
        | "pending"
        | "halted"
        | "paused"
        | "resumed"
        | "cancelled"
        | "completed"
        | "updated";
      subscription: ProviderSubscription;
      payment: ProviderPayment | null;
    }
  | { kind: "ignored"; eventId: string; type: string };

export type ProviderSubscription = {
  id: string;
  planId: string;
  status:
    | "created"
    | "authenticated"
    | "active"
    | "pending"
    | "halted"
    | "cancelled"
    | "completed"
    | "expired"
    | "paused";
  currentStart: Date | null;
  currentEnd: Date | null;
  chargeAt: Date | null;
  paidCount: number;
  notes: Record<string, string>;
  shortUrl?: string | null;
};

export type CredentialCheck = { ok: true } | { ok: false; reason: string };

/** Gym payments (tenant-owned Razorpay accounts). */
export interface PaymentProvider {
  readonly name: "RAZORPAY" | "FAKE";
  verifyCredentials(): Promise<CredentialCheck>;
  createPaymentLink(input: CreateLinkInput): Promise<ProviderLink>;
  fetchPaymentLink(id: string): Promise<ProviderLink>;
  cancelPaymentLink(id: string): Promise<ProviderLink>;
  fetchPayment(id: string): Promise<ProviderPayment>;
  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;
  fetchRefund(paymentId: string, refundId: string): Promise<ProviderRefund>;
}

/** Platform SaaS billing (the operator's own account). */
export interface SubscriptionProvider {
  readonly name: "RAZORPAY" | "FAKE";
  verifyCredentials(): Promise<CredentialCheck>;
  createPlan(input: {
    period: "monthly" | "yearly";
    interval: number;
    name: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ id: string }>;
  createSubscription(input: {
    planId: string;
    totalCount: number;
    notes: Record<string, string>;
    customerNotify: boolean;
  }): Promise<ProviderSubscription & { shortUrl: string | null }>;
  fetchSubscription(id: string): Promise<ProviderSubscription>;
  cancelSubscription(
    id: string,
    atCycleEnd: boolean,
  ): Promise<ProviderSubscription>;
  changePlan(
    id: string,
    planId: string,
    when: "now" | "cycle_end",
  ): Promise<ProviderSubscription>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
