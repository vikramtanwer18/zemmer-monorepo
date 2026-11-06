import { describe, expect, it } from "vitest";
import {
  canMoveTo,
  categoryRank,
  cleanUtm,
  DEFAULT_STAGES,
  matchKind,
  mergeTouches,
  nextRoundRobin,
  normalizeEmail,
  parseApiKey,
  parseTrialQr,
  scoreLead,
  sourceCodeFor,
  statusForCategory,
  TRIAL_QR_PREFIX,
  newTrialPassCode,
  type Touch,
} from "./rules";

describe("duplicate matching", () => {
  it("matches on phone, email or both; empty values never match", () => {
    const a = { phone: "+919876500001", email: "asha@x.in" };
    expect(matchKind(a, { phone: "+919876500001", email: "asha@x.in" })).toBe(
      "both",
    );
    expect(matchKind(a, { phone: "+919876500001", email: null })).toBe("phone");
    expect(matchKind(a, { phone: "+919876500002", email: "asha@x.in" })).toBe(
      "email",
    );
    expect(
      matchKind({ phone: null, email: null }, { phone: null, email: null }),
    ).toBeNull();
  });
  it("normalises email and rejects junk", () => {
    expect(normalizeEmail("  Asha@X.IN ")).toBe("asha@x.in");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("round-robin", () => {
  it("is fair: every eligible person gets the same number of leads", () => {
    const team = ["c", "a", "b"];
    let last: string | null = null;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      last = nextRoundRobin(team, last);
      counts[last!] = (counts[last!] ?? 0) + 1;
    }
    expect(counts).toEqual({ a: 10, b: 10, c: 10 });
  });
  it("continues after someone leaves the team, and wraps", () => {
    expect(nextRoundRobin(["a", "c"], "b")).toBe("c");
    expect(nextRoundRobin(["a", "c"], "c")).toBe("a");
    expect(nextRoundRobin([], "a")).toBeNull();
    expect(nextRoundRobin(["b", "a"], null)).toBe("a");
  });
});

describe("scoring", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  const base = {
    sourcePoints: 10,
    createdAt: now,
    now,
    responded: false,
    trialBooked: false,
    trialAttended: false,
    trialNoShow: false,
    category: "NEW" as const,
  };
  it("adds transparent parts and clamps to 0–100", () => {
    const fresh = scoreLead(base);
    expect(fresh.score).toBe(30);
    expect(fresh.parts.map((p) => p.rule)).toEqual(["source", "recency"]);
    const hot = scoreLead({
      ...base,
      sourcePoints: 20,
      responded: true,
      trialBooked: true,
      trialAttended: true,
      category: "OFFER_SENT",
    });
    expect(hot.score).toBe(100);
    const cold = scoreLead({
      ...base,
      sourcePoints: 0,
      createdAt: new Date(now.getTime() - 60 * 86_400_000),
      trialNoShow: true,
    });
    expect(cold.score).toBe(0);
    expect(cold.parts).toEqual([
      { rule: "trial_no_show", label: "Missed a trial", points: -10 },
    ]);
  });
  it("recency decays", () => {
    const d = (days: number) =>
      scoreLead({
        ...base,
        sourcePoints: 0,
        createdAt: new Date(now.getTime() - days * 86_400_000),
      }).score;
    expect([d(1), d(3), d(10), d(40)]).toEqual([20, 10, 5, 0]);
  });
});

describe("stage categories", () => {
  it("maps categories to lead status and funnel order", () => {
    expect(statusForCategory("WON")).toBe("WON");
    expect(statusForCategory("LOST")).toBe("LOST");
    expect(statusForCategory("OFFER_SENT")).toBe("OPEN");
    expect(categoryRank("NEW")).toBeLessThan(categoryRank("TRIAL_ATTENDED"));
    expect(categoryRank("LOST")).toBe(-1);
    expect(canMoveTo("WON")).toBe(false);
    expect(canMoveTo("CONTACTED")).toBe(true);
    expect(DEFAULT_STAGES).toHaveLength(7);
  });
});

describe("attribution", () => {
  const touch = (campaignId: string | null, at: string): Touch => ({
    at,
    via: "FORM",
    sourceId: null,
    campaignId,
    utm: {},
  });
  it("keeps the first touch and moves the last touch", () => {
    const first = mergeTouches({ first: null, last: null }, touch("A", "1"));
    expect(first).toEqual({ first: touch("A", "1"), last: touch("A", "1") });
    const second = mergeTouches(first, touch("B", "2"));
    expect(second.first.campaignId).toBe("A");
    expect(second.last.campaignId).toBe("B");
  });
  it("cleans UTM values and maps sources", () => {
    expect(
      cleanUtm({ utm_source: " fb ", utm_campaign: "Diwali", utm_medium: "" }),
    ).toMatchObject({ source: "fb", campaign: "Diwali", medium: null });
    expect(sourceCodeFor("FB")).toBe("facebook");
    expect(sourceCodeFor("Instagram")).toBe("instagram");
    expect(sourceCodeFor("news letter")).toBe("news_letter");
    expect(sourceCodeFor("")).toBeNull();
  });
});

describe("trial pass and API keys", () => {
  it("trial QR round-trips and refuses anything else", () => {
    const code = newTrialPassCode();
    expect(parseTrialQr(`${TRIAL_QR_PREFIX}${code}`)).toBe(code);
    expect(parseTrialQr("GM1.something")).toBeNull();
    expect(parseTrialQr(`${TRIAL_QR_PREFIX}short`)).toBeNull();
  });
  it("parses API keys strictly", () => {
    const key = `gk_${"a".repeat(12)}_${"b".repeat(32)}`;
    expect(parseApiKey(key)).toEqual({
      prefix: "a".repeat(12),
      secret: "b".repeat(32),
    });
    expect(parseApiKey(`Bearer ${key}`)).toBeNull();
    expect(parseApiKey("gk_short_x")).toBeNull();
  });
});

describe("public API document", () => {
  it("lists exactly the fields the API accepts", async () => {
    const { publicApiDocument } = await import("./openapi");
    const { apiLeadSchema } = await import("./capture");
    const doc = publicApiDocument("https://app.example.in");
    const props =
      doc.paths["/api/public/v1/leads"].post.requestBody.content[
        "application/json"
      ].schema.properties;
    expect(Object.keys(props).sort()).toEqual(
      Object.keys(apiLeadSchema.shape).sort(),
    );
    // A cold dynamic import can pass 5 s when every package's tests run at once.
  }, 20_000);
});
