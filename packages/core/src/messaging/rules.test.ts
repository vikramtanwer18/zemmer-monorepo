import { describe, expect, it } from "vitest";
import {
  cleanParameter,
  evaluateSendGate,
  matchKeyword,
  messagingLimitCount,
  nextOutboundStatus,
  renderTemplateBody,
  resolveConsent,
  templateParameters,
  toMetaPhone,
  fromMetaPhone,
  withinServiceWindow,
  type GateInput,
} from "./rules";
import {
  resolveVariables,
  suggestVariableMap,
  unmappedVariables,
} from "./variables";

const now = new Date("2026-11-05T10:00:00Z");
const base: GateInput = {
  planAllows: true,
  accountStatus: "ACTIVE",
  kind: "TEMPLATE",
  purpose: "CAMPAIGN",
  category: "MARKETING",
  templateStatus: "APPROVED",
  suppressed: false,
  consent: { service: true, marketing: true },
  lastInboundAt: null,
  now,
  marketingSentLast24h: 0,
  marketingDailyCap: 1,
  monthlyUsed: 0,
  monthlyLimit: null,
};

describe("send gate (checked at send time)", () => {
  it("lets a consented marketing template through", () => {
    expect(evaluateSendGate(base)).toEqual({ ok: true });
  });

  it("needs marketing consent for MARKETING and service consent for UTILITY", () => {
    expect(
      evaluateSendGate({
        ...base,
        consent: { service: true, marketing: false },
      }),
    ).toEqual({ ok: false, reason: "NO_MARKETING_CONSENT" });
    expect(
      evaluateSendGate({
        ...base,
        category: "UTILITY",
        consent: { service: true, marketing: false },
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateSendGate({
        ...base,
        category: "UTILITY",
        consent: { service: false, marketing: true },
      }),
    ).toEqual({ ok: false, reason: "NO_SERVICE_CONSENT" });
  });

  it("suppression beats consent, for every category and purpose (even tests)", () => {
    for (const category of ["MARKETING", "UTILITY"] as const)
      for (const purpose of [
        "CAMPAIGN",
        "AUTOMATION",
        "NOTIFICATION",
        "TEST",
      ] as const)
        expect(
          evaluateSendGate({ ...base, category, purpose, suppressed: true }),
        ).toEqual({ ok: false, reason: "SUPPRESSED" });
    // Only the opt-out confirmation reply may reach a suppressed number.
    expect(
      evaluateSendGate({
        ...base,
        kind: "TEXT",
        purpose: "INBOX",
        suppressed: true,
        bypassSuppression: true,
        lastInboundAt: now,
        consent: { service: false, marketing: false },
      }),
    ).toEqual({ ok: true });
  });

  it("free text only inside the 24-hour window", () => {
    const text = {
      ...base,
      kind: "TEXT" as const,
      purpose: "INBOX" as const,
      category: "OTHER" as const,
    };
    expect(evaluateSendGate({ ...text, lastInboundAt: null })).toEqual({
      ok: false,
      reason: "OUTSIDE_WINDOW",
    });
    expect(
      evaluateSendGate({
        ...text,
        lastInboundAt: new Date(now.getTime() - 25 * 3600_000),
      }),
    ).toEqual({ ok: false, reason: "OUTSIDE_WINDOW" });
    expect(
      evaluateSendGate({
        ...text,
        lastInboundAt: new Date(now.getTime() - 23 * 3600_000),
      }),
    ).toEqual({ ok: true });
  });

  it("refuses unapproved templates, inactive accounts and an exhausted quota", () => {
    expect(evaluateSendGate({ ...base, templateStatus: "PENDING" })).toEqual({
      ok: false,
      reason: "TEMPLATE_NOT_APPROVED",
    });
    expect(
      evaluateSendGate({ ...base, accountStatus: "DISCONNECTED" }),
    ).toEqual({ ok: false, reason: "ACCOUNT_INACTIVE" });
    expect(
      evaluateSendGate({ ...base, monthlyLimit: 100, monthlyUsed: 100 }),
    ).toEqual({ ok: false, reason: "QUOTA_EXCEEDED" });
    expect(evaluateSendGate({ ...base, planAllows: false })).toEqual({
      ok: false,
      reason: "NOT_ON_PLAN",
    });
  });

  it("caps promotional messages per number per day; reminders are not capped", () => {
    expect(evaluateSendGate({ ...base, marketingSentLast24h: 1 })).toEqual({
      ok: false,
      reason: "DAILY_CAP",
    });
    expect(
      evaluateSendGate({
        ...base,
        purpose: "AUTOMATION",
        marketingSentLast24h: 1,
      }),
    ).toEqual({ ok: false, reason: "DAILY_CAP" });
    expect(
      evaluateSendGate({
        ...base,
        marketingDailyCap: 2,
        marketingSentLast24h: 1,
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateSendGate({
        ...base,
        category: "UTILITY",
        marketingSentLast24h: 5,
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateSendGate({
        ...base,
        purpose: "TEST",
        consent: { service: false, marketing: false },
        marketingSentLast24h: 9,
      }),
    ).toEqual({ ok: true });
  });
});

describe("24-hour window", () => {
  it("is measured from the last inbound message", () => {
    expect(withinServiceWindow(null, now)).toBe(false);
    expect(withinServiceWindow(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(
      withinServiceWindow(new Date(now.getTime() - 24 * 3600_000), now),
    ).toBe(false);
    expect(withinServiceWindow(new Date(now.getTime() + 60_000), now)).toBe(
      false,
    );
  });
});

describe("opt-out / opt-in keywords", () => {
  const out = ["stop", "unsubscribe", "band karo", "बंद करो"];
  const back = ["start"];
  it("matches whole messages, any case and punctuation, Hindi and transliterations", () => {
    expect(matchKeyword("STOP", out, back)).toEqual({
      kind: "OPT_OUT",
      keyword: "stop",
    });
    expect(matchKeyword("  Stop!! ", out, back)?.kind).toBe("OPT_OUT");
    expect(matchKeyword("Band   Karo.", out, back)?.kind).toBe("OPT_OUT");
    expect(matchKeyword("बंद करो", out, back)?.kind).toBe("OPT_OUT");
    expect(matchKeyword("start", out, back)?.kind).toBe("OPT_IN");
  });
  it("never fires inside a sentence", () => {
    expect(
      matchKeyword("please don't stop the reminders", out, back),
    ).toBeNull();
    expect(matchKeyword("stopwatch", out, back)).toBeNull();
    expect(matchKeyword("", out, back)).toBeNull();
    expect(matchKeyword(null, out, back)).toBeNull();
  });
});

describe("consent history", () => {
  it("latest row per purpose wins; members default to service yes, marketing no", () => {
    const t = (m: number) => new Date(now.getTime() + m * 60_000);
    expect(resolveConsent([], { service: true, marketing: false })).toEqual({
      service: true,
      marketing: false,
    });
    expect(
      resolveConsent(
        [
          { purpose: "MARKETING", status: "GRANTED", capturedAt: t(1) },
          { purpose: "MARKETING", status: "REVOKED", capturedAt: t(2) },
          { purpose: "SERVICE", status: "REVOKED", capturedAt: t(0) },
        ],
        { service: true, marketing: false },
      ),
    ).toEqual({ service: false, marketing: false });
  });
});

describe("templates and variables", () => {
  it("renders positional and named bodies", () => {
    expect(renderTemplateBody("Hi {{1}}, ends {{2}}", ["Asha", "5 Dec"])).toBe(
      "Hi Asha, ends 5 Dec",
    );
    expect(
      renderTemplateBody("Hi {{first_name}} from {{gym}}", {
        first_name: "Asha",
        gym: "Iron",
      }),
    ).toBe("Hi Asha from Iron");
  });
  it("orders positional parameters numerically and cleans values Meta would reject", () => {
    expect(
      templateParameters(["2", "10", "1"], "POSITIONAL", {
        "1": "a",
        "2": "b",
        "10": "c",
      }),
    ).toEqual(["a", "b", "c"]);
    expect(
      templateParameters(["first_name"], "NAMED", { first_name: "A\nB" }),
    ).toEqual({ first_name: "A B" });
    expect(cleanParameter("")).toBe("-");
    expect(cleanParameter("a      b")).toBe("a   b");
  });
  it("maps placeholders to fields; literal text is allowed; nothing else", () => {
    const map = suggestVariableMap(["first_name", "gym", "offer"]);
    expect(unmappedVariables(["first_name", "gym", "offer"], map)).toEqual([
      "offer",
    ]);
    expect(
      resolveVariables(
        { ...map, offer: { text: "20% off" } },
        { first_name: "Asha", gym_name: "Iron" },
      ),
    ).toEqual({ first_name: "Asha", gym: "Iron", offer: "20% off" });
  });
  it("phone formats and tier limits", () => {
    expect(toMetaPhone("+919800000001")).toBe("919800000001");
    expect(fromMetaPhone("919800000001")).toBe("+919800000001");
    expect(messagingLimitCount("TIER_1K")).toBe(1000);
    expect(messagingLimitCount("TIER_250")).toBe(250);
    expect(messagingLimitCount("TIER_UNLIMITED")).toBeNull();
    expect(messagingLimitCount(null)).toBe(250);
  });
});

describe("delivery status ordering (out-of-order webhooks)", () => {
  it("only moves forward", () => {
    expect(nextOutboundStatus("SENT", "delivered")).toBe("DELIVERED");
    expect(nextOutboundStatus("READ", "delivered")).toBeNull();
    expect(nextOutboundStatus("SENT", "sent")).toBeNull();
    expect(nextOutboundStatus("SENDING", "read")).toBe("READ");
    expect(nextOutboundStatus("DELIVERED", "failed")).toBe("FAILED");
    expect(nextOutboundStatus("READ", "failed")).toBeNull();
    expect(nextOutboundStatus("FAILED", "delivered")).toBe("DELIVERED");
    expect(nextOutboundStatus("SKIPPED", "sent")).toBeNull();
  });
});
