import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "@gym/core/errors";
import type { RateLimiter } from "./rate-limit";

/** D-03: 6 digits, ≤10 min, single use, hashed at rest, attempts capped, rate-limited. */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** HMAC keyed by the realm secret and bound to the challenge id, so hashes can't be reused. */
export function hashOtp(
  secret: string,
  challengeId: string,
  code: string,
): string {
  return createHmac("sha256", secret)
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export type OtpChallengeRow = {
  id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
};

export type OtpCheck =
  | { status: "ok" }
  | { status: "none" }
  | { status: "expired" }
  | { status: "locked" }
  | { status: "invalid"; attemptsLeft: number };

/** Pure decision for one verification attempt (before the attempt is recorded). */
export function checkOtp(
  challenge: OtpChallengeRow | null,
  code: string,
  now: Date,
  secret: string,
): OtpCheck {
  if (!challenge || challenge.consumedAt) return { status: "none" };
  if (challenge.expiresAt <= now) return { status: "expired" };
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) return { status: "locked" };
  const expected = Buffer.from(challenge.codeHash, "hex");
  const actual = Buffer.from(hashOtp(secret, challenge.id, code), "hex");
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    return { status: "ok" };
  }
  return {
    status: "invalid",
    attemptsLeft: Math.max(OTP_MAX_ATTEMPTS - challenge.attempts - 1, 0),
  };
}

/** Storage for one realm's challenges (app.otp_challenge or platform.platform_otp_challenge). */
export type OtpStore = {
  latest(sessionId: string): Promise<OtpChallengeRow | null>;
  create(row: {
    id: string;
    sessionId: string;
    codeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  /** Increments attempts atomically. */
  recordFailedAttempt(id: string): Promise<void>;
  /** Marks consumed if not already; returns false if someone else consumed it first. */
  consume(id: string, now: Date): Promise<boolean>;
  markSessionVerified(sessionId: string, now: Date): Promise<void>;
};

export type OtpServiceOptions = {
  store: OtpStore;
  secret: string;
  limiter: RateLimiter;
  sendCode: (to: string, code: string, minutes: number) => Promise<void>;
  now?: () => Date;
};

export class OtpService {
  constructor(private readonly options: OtpServiceOptions) {}

  private now() {
    return this.options.now ? this.options.now() : new Date();
  }

  /** Emails a new code. Older codes for the session stop working (only the latest counts). */
  async send(input: {
    sessionId: string;
    userId: string;
    email: string;
    ip: string | null;
  }) {
    const { limiter, store } = this.options;
    const now = this.now();
    const latest = await store.latest(input.sessionId);
    if (
      latest &&
      now.getTime() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      const wait = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS -
          (now.getTime() - latest.createdAt.getTime())) /
          1000,
      );
      throw new AppError(
        "RATE_LIMITED",
        `Please wait ${wait} seconds before asking for another code.`,
        {
          details: { retryAfterSeconds: wait },
        },
      );
    }
    await limiter.consume("otp-send:account", input.userId);
    if (input.ip) await limiter.consume("otp-send:ip", input.ip);

    const id = randomUUID();
    const code = generateOtpCode();
    await store.create({
      id,
      sessionId: input.sessionId,
      codeHash: hashOtp(this.options.secret, id, code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });
    await this.options.sendCode(input.email, code, OTP_TTL_MS / 60_000);
  }

  /** Verifies a code and marks the session as having passed the second factor. */
  async verify(input: {
    sessionId: string;
    userId: string;
    ip: string | null;
    code: string;
  }) {
    const { limiter, store } = this.options;
    const code = input.code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      throw new AppError("VALIDATION_FAILED", "Enter the 6-digit code.", {
        fields: { code: ["Enter the 6-digit code."] },
      });
    }
    await limiter.consume("otp-verify:account", input.userId);
    if (input.ip) await limiter.consume("otp-verify:ip", input.ip);

    const now = this.now();
    const challenge = await store.latest(input.sessionId);
    const result = checkOtp(challenge, code, now, this.options.secret);
    switch (result.status) {
      case "none":
        throw new AppError("VALIDATION_FAILED", "Send yourself a code first.");
      case "expired":
        throw new AppError(
          "VALIDATION_FAILED",
          "That code has expired. Send a new one.",
        );
      case "locked":
        throw new AppError(
          "RATE_LIMITED",
          "Too many wrong codes. Send a new one.",
        );
      case "invalid":
        await store.recordFailedAttempt(challenge!.id);
        throw new AppError(
          "VALIDATION_FAILED",
          result.attemptsLeft > 0
            ? `That code isn't right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? "" : "s"} left.`
            : "That code isn't right. Send a new one.",
          { fields: { code: ["That code isn't right."] } },
        );
      case "ok": {
        const consumed = await store.consume(challenge!.id, now);
        if (!consumed)
          throw new AppError(
            "VALIDATION_FAILED",
            "That code was already used.",
          );
        await store.markSessionVerified(input.sessionId, now);
      }
    }
  }
}
