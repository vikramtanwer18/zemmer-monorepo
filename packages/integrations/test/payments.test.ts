import { describe, expect, it } from "vitest";
import {
  FakePaymentProvider,
  FakeSubscriptionProvider,
  memoryFakeStore,
  parseRazorpayWebhook,
  RazorpayPaymentProvider,
  signWebhook,
  verifyWebhookSignature,
} from "../src/payments/index";

const SECRET = "whsec_test_123";

describe("webhook signatures", () => {
  it("accepts the exact raw body and rejects anything else", () => {
    const body = '{"event":"payment_link.paid","payload":{}}';
    const sig = signWebhook(body, SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    // Re-serialised JSON (spacing) is a different body.
    expect(
      verifyWebhookSignature(
        '{"event": "payment_link.paid","payload":{}}',
        sig,
        SECRET,
      ),
    ).toBe(false);
    expect(verifyWebhookSignature(body, sig, "other-secret")).toBe(false);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "not-hex", SECRET)).toBe(false);
  });
});

describe("Razorpay payload parsing (shapes from the docs)", () => {
  it("normalizes payment_link.partially_paid with its payment", () => {
    const body = JSON.stringify({
      entity: "event",
      account_id: "acc_x",
      event: "payment_link.partially_paid",
      contains: ["payment_link", "order", "payment"],
      payload: {
        payment_link: {
          entity: {
            id: "plink_1",
            status: "partially_paid",
            amount: 100000,
            amount_paid: 40000,
            reference_id: "GL-abc",
          },
        },
        payment: {
          entity: {
            id: "pay_1",
            amount: 40000,
            currency: "INR",
            status: "captured",
            method: "upi",
            created_at: 1793800000,
          },
        },
        order: { entity: { id: "order_1" } },
      },
      created_at: 1793800000,
    });
    const e = parseRazorpayWebhook(body, "evt_1");
    expect(e).toMatchObject({
      kind: "link",
      eventId: "evt_1",
      type: "partially_paid",
      linkId: "plink_1",
      referenceId: "GL-abc",
      payment: {
        id: "pay_1",
        amountMinor: 40000,
        status: "captured",
        method: "upi",
      },
    });
  });

  it("normalizes refunds and subscriptions; unknown events are ignored", () => {
    const refund = parseRazorpayWebhook(
      JSON.stringify({
        event: "refund.processed",
        payload: {
          refund: {
            entity: {
              id: "rfnd_1",
              payment_id: "pay_1",
              amount: 5000,
              status: "processed",
              receipt: "RF-1",
            },
          },
        },
      }),
      "evt_2",
    );
    expect(refund).toMatchObject({
      kind: "refund",
      type: "processed",
      refund: { id: "rfnd_1", amountMinor: 5000, receipt: "RF-1" },
    });
    const sub = parseRazorpayWebhook(
      JSON.stringify({
        event: "subscription.charged",
        payload: {
          subscription: {
            entity: {
              id: "sub_1",
              plan_id: "plan_1",
              status: "active",
              current_start: 1793800000,
              current_end: 1796400000,
              paid_count: 1,
              notes: [],
            },
          },
          payment: {
            entity: {
              id: "pay_9",
              amount: 99900,
              currency: "INR",
              status: "captured",
            },
          },
        },
      }),
      "evt_3",
    );
    expect(sub).toMatchObject({
      kind: "subscription",
      type: "charged",
      subscription: { id: "sub_1", paidCount: 1, notes: {} },
      payment: { id: "pay_9" },
    });
    expect(
      parseRazorpayWebhook('{"event":"order.paid","payload":{}}', "evt_4"),
    ).toEqual({
      kind: "ignored",
      eventId: "evt_4",
      type: "order.paid",
    });
  });

  it("falls back to a stable id when the event-id header is missing", () => {
    const body =
      '{"event":"payment_link.expired","payload":{"payment_link":{"entity":{"id":"plink_2","status":"expired"}}}}';
    expect(parseRazorpayWebhook(body, null).eventId).toBe(
      parseRazorpayWebhook(body, null).eventId,
    );
  });
});

describe("Razorpay REST client", () => {
  it("creates a partial-payment link with our reference id and no Razorpay notifications", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify({
          id: "plink_x",
          reference_id: "GL-1",
          status: "created",
          amount: 120000,
          amount_paid: 0,
          short_url: "https://rzp.io/i/x",
          expire_by: 1793900000,
        }),
        { status: 200 },
      );
    };
    const rp = new RazorpayPaymentProvider("rzp_test_key", "secret", fakeFetch);
    const link = await rp.createPaymentLink({
      amountMinor: 120000,
      currency: "INR",
      referenceId: "GL-1",
      description: "Invoice IT/26-27/00001",
      acceptPartial: true,
      minPartialMinor: 50000,
      expiresAt: new Date(1793900000 * 1000),
      customer: { name: "Asha", email: "a@x.test", contact: "+919800000000" },
      callbackUrl: "https://app.example/m/pay/return",
    });
    expect(link).toMatchObject({
      id: "plink_x",
      shortUrl: "https://rzp.io/i/x",
      status: "created",
    });
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/payment_links");
    const auth = new Headers(calls[0]!.init.headers).get("Authorization");
    expect(auth).toBe(
      `Basic ${Buffer.from("rzp_test_key:secret").toString("base64")}`,
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      amount: 120000,
      accept_partial: true,
      first_min_partial_amount: 50000,
      reference_id: "GL-1",
      expire_by: 1793900000,
      notify: { sms: false, email: false },
      callback_url: "https://app.example/m/pay/return",
      callback_method: "get",
    });
  });

  it("reports a 401 as bad credentials without leaking them", async () => {
    const rp = new RazorpayPaymentProvider(
      "k",
      "s",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "BAD_REQUEST_ERROR",
              description: "Authentication failed",
            },
          }),
          { status: 401 },
        ),
    );
    const check = await rp.verifyCredentials();
    expect(check).toEqual({
      ok: false,
      reason: "Razorpay rejected the key id or secret.",
    });
  });
});

describe("fake provider", () => {
  it("behaves like Razorpay: unique reference ids, partial then remainder, refunds by receipt", async () => {
    const fake = new FakePaymentProvider(memoryFakeStore(), "acct1", "ok");
    const link = await fake.createPaymentLink({
      amountMinor: 100000,
      currency: "INR",
      referenceId: "GL-1",
      description: "x",
      acceptPartial: true,
      minPartialMinor: 10000,
      customer: { name: "A" },
    });
    await expect(
      fake.createPaymentLink({
        amountMinor: 1,
        currency: "INR",
        referenceId: "GL-1",
        description: "x",
        acceptPartial: false,
        customer: { name: "A" },
      }),
    ).rejects.toThrow(/reference_id already exists/);
    const first = await fake.pay(link.id, 40000);
    expect(JSON.parse(first.webhook.rawBody).event).toBe(
      "payment_link.partially_paid",
    );
    const second = await fake.pay(link.id);
    expect(JSON.parse(second.webhook.rawBody).event).toBe("payment_link.paid");
    const fetched = await fake.fetchPaymentLink(link.id);
    expect(fetched).toMatchObject({ status: "paid", amountPaidMinor: 100000 });
    expect(fetched.payments.map((p) => p.amountMinor)).toEqual([40000, 60000]);
    // The webhook parses like a real one.
    expect(
      parseRazorpayWebhook(second.webhook.rawBody, second.webhook.eventId),
    ).toMatchObject({
      kind: "link",
      type: "paid",
      payment: { id: second.paymentId, amountMinor: 60000 },
    });
    const refund = await fake.createRefund({
      paymentId: second.paymentId,
      amountMinor: 20000,
      receipt: "RF-1",
    });
    await expect(
      fake.createRefund({
        paymentId: second.paymentId,
        amountMinor: 20000,
        receipt: "RF-1",
      }),
    ).rejects.toThrow(/Duplicate receipt/);
    await expect(
      fake.createRefund({
        paymentId: second.paymentId,
        amountMinor: 50000,
        receipt: "RF-2",
      }),
    ).rejects.toThrow(/greater than amount captured/);
    const settled = await fake.settleRefund(refund.id, "processed");
    expect(
      parseRazorpayWebhook(settled.rawBody, settled.eventId),
    ).toMatchObject({ kind: "refund", type: "processed" });
  });

  it("drives a subscription through charge, failure and halt", async () => {
    const subs = new FakeSubscriptionProvider(memoryFakeStore());
    const plan = await subs.createPlan({
      period: "monthly",
      interval: 1,
      name: "Growth",
      amountMinor: 199900,
      currency: "INR",
    });
    const sub = await subs.createSubscription({
      planId: plan.id,
      totalCount: 120,
      notes: { tenantId: "t1" },
      customerNotify: true,
    });
    const charged = await subs.simulate(sub.id, "charge");
    expect(charged.map((w) => w.event)).toEqual([
      "subscription.activated",
      "subscription.charged",
    ]);
    expect((await subs.simulate(sub.id, "fail"))[0]!.event).toBe(
      "subscription.pending",
    );
    expect((await subs.simulate(sub.id, "halt"))[0]!.event).toBe(
      "subscription.halted",
    );
    expect((await subs.fetchSubscription(sub.id)).status).toBe("halted");
  });
});
