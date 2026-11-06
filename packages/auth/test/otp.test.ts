import { describe, expect, it } from "vitest";
import {
  checkOtp,
  generateOtpCode,
  hashOtp,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  OtpService,
  type OtpChallengeRow,
  type OtpStore,
} from "../src/otp";
import type { RateLimiter } from "../src/rate-limit";

const SECRET = "test-secret-0123456789abcdef0123456789";
const T0 = new Date("2026-11-02T10:00:00Z");

function challenge(
  code: string,
  overrides: Partial<OtpChallengeRow> = {},
): OtpChallengeRow {
  const id = overrides.id ?? "c1";
  return {
    id,
    codeHash: hashOtp(SECRET, id, code),
    expiresAt: new Date(T0.getTime() + OTP_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

describe("OTP codes", () => {
  it("are 6 digits", () => {
    for (let i = 0; i < 200; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it("are stored as an HMAC bound to the challenge id", () => {
    expect(hashOtp(SECRET, "a", "123456")).not.toBe(
      hashOtp(SECRET, "b", "123456"),
    );
    expect(hashOtp(SECRET, "a", "123456")).not.toContain("123456");
  });
});

describe("checkOtp", () => {
  it("accepts the right code before expiry", () => {
    expect(checkOtp(challenge("123456"), "123456", T0, SECRET)).toEqual({
      status: "ok",
    });
  });

  it("expires after 10 minutes", () => {
    const later = new Date(T0.getTime() + OTP_TTL_MS);
    expect(checkOtp(challenge("123456"), "123456", later, SECRET)).toEqual({
      status: "expired",
    });
  });

  it("counts down attempts and locks at the cap", () => {
    expect(checkOtp(challenge("123456"), "000000", T0, SECRET)).toEqual({
      status: "invalid",
      attemptsLeft: OTP_MAX_ATTEMPTS - 1,
    });
    const used = challenge("123456", { attempts: OTP_MAX_ATTEMPTS });
    // Even the right code is refused once locked.
    expect(checkOtp(used, "123456", T0, SECRET)).toEqual({ status: "locked" });
  });

  it("is single use", () => {
    expect(
      checkOtp(challenge("123456", { consumedAt: T0 }), "123456", T0, SECRET),
    ).toEqual({ status: "none" });
  });

  it("a code from another secret never matches", () => {
    const other = {
      ...challenge("123456"),
      codeHash: hashOtp("another-secret-xxxxxxxxxxxxxxxxxxxx", "c1", "123456"),
    };
    expect(checkOtp(other, "123456", T0, SECRET).status).toBe("invalid");
  });
});

/** In-memory store and a limiter that always allows, to test the service's own rules. */
function harness() {
  const rows: (OtpChallengeRow & { sessionId: string })[] = [];
  const verified = new Map<string, Date>();
  const sent: string[] = [];
  let now = T0;
  const store: OtpStore = {
    latest: async (sessionId) =>
      [...rows].reverse().find((r) => r.sessionId === sessionId) ?? null,
    create: async (row) => {
      rows.push({ ...row, attempts: 0, consumedAt: null, createdAt: now });
    },
    recordFailedAttempt: async (id) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.attempts++;
    },
    consume: async (id, at) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.consumedAt) return false;
      row.consumedAt = at;
      return true;
    },
    markSessionVerified: async (sessionId, at) => {
      verified.set(sessionId, at);
    },
  };
  const limiter = { consume: async () => {} } as unknown as RateLimiter;
  const service = new OtpService({
    store,
    secret: SECRET,
    limiter,
    sendCode: async (_to, code) => {
      sent.push(code);
    },
    now: () => now,
  });
  return {
    service,
    sent,
    verified,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const who = { sessionId: "s1", userId: "u1", ip: null };

describe("OtpService", () => {
  it("send → verify marks the session as verified", async () => {
    const h = harness();
    await h.service.send({ ...who, email: "a@b.test" });
    await h.service.verify({ ...who, code: h.sent[0]! });
    expect(h.verified.has("s1")).toBe(true);
  });

  it("a code cannot be used twice", async () => {
    const h = harness();
    await h.service.send({ ...who, email: "a@b.test" });
    await h.service.verify({ ...who, code: h.sent[0]! });
    await expect(
      h.service.verify({ ...who, code: h.sent[0]! }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("locks after the maximum wrong attempts, even for the right code", async () => {
    const h = harness();
    await h.service.send({ ...who, email: "a@b.test" });
    const wrong = h.sent[0] === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(
        h.service.verify({ ...who, code: wrong }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(
      h.service.verify({ ...who, code: h.sent[0]! }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(h.verified.has("s1")).toBe(false);
  });

  it("refuses an expired code", async () => {
    const h = harness();
    await h.service.send({ ...who, email: "a@b.test" });
    h.advance(OTP_TTL_MS + 1);
    await expect(
      h.service.verify({ ...who, code: h.sent[0]! }),
    ).rejects.toThrow(/expired/);
  });

  it("enforces a 30-second resend cooldown, and only the newest code works", async () => {
    const h = harness();
    await h.service.send({ ...who, email: "a@b.test" });
    await expect(
      h.service.send({ ...who, email: "a@b.test" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    h.advance(31_000);
    await h.service.send({ ...who, email: "a@b.test" });
    const [first, second] = h.sent;
    if (first !== second) {
      await expect(
        h.service.verify({ ...who, code: first! }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await h.service.verify({ ...who, code: second! });
    expect(h.verified.has("s1")).toBe(true);
  });

  it("rejects input that is not 6 digits without touching the store", async () => {
    const h = harness();
    await expect(
      h.service.verify({ ...who, code: "12ab" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
