import { AppError } from "@gym/core/errors";
import type { Redis } from "ioredis";

/**
 * Fixed-window counters in Redis (D-03: login, OTP, reset and invite endpoints, per IP and per
 * account). Fail-open on Redis errors would let attackers bypass limits, so errors propagate.
 */
export type RateRule = { limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  "signin:ip": { limit: 30, windowSeconds: 15 * 60 },
  /** Failed password attempts per account before a 15-minute lockout. */
  "signin-fail:account": { limit: 5, windowSeconds: 15 * 60 },
  "signup:ip": { limit: 10, windowSeconds: 60 * 60 },
  "otp-send:account": { limit: 5, windowSeconds: 15 * 60 },
  "otp-send:ip": { limit: 20, windowSeconds: 15 * 60 },
  "otp-verify:account": { limit: 10, windowSeconds: 15 * 60 },
  "otp-verify:ip": { limit: 30, windowSeconds: 15 * 60 },
  "reset:account": { limit: 3, windowSeconds: 60 * 60 },
  "reset:ip": { limit: 10, windowSeconds: 60 * 60 },
  "verify-email:account": { limit: 5, windowSeconds: 60 * 60 },
  "invite-accept:ip": { limit: 20, windowSeconds: 15 * 60 },
  "invite-accept:account": { limit: 10, windowSeconds: 15 * 60 },
  "join:account": { limit: 5, windowSeconds: 60 * 60 },
  // M5: public lead capture (per visitor IP and per form), and the website API (per key).
  "lead-form:ip": { limit: 10, windowSeconds: 60 * 60 },
  "lead-form:form": { limit: 300, windowSeconds: 60 * 60 },
  // M7: public referral links (per IP, and per referral code).
  "referral-form:ip": { limit: 10, windowSeconds: 60 * 60 },
  "referral-form:code": { limit: 50, windowSeconds: 60 * 60 },
  "lead-api:key": { limit: 600, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
};

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    /** Separates realms and tests, e.g. "gym:rl:tenant". */
    private readonly prefix: string,
  ) {}

  private key(name: RateLimitName, subject: string) {
    return `${this.prefix}:${name}:${subject.toLowerCase()}`;
  }

  /** Counts one hit and reports whether it is within the limit. */
  async hit(name: RateLimitName, subject: string): Promise<RateLimitResult> {
    const rule: RateRule = RATE_LIMITS[name];
    const key = this.key(name, subject);
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, rule.windowSeconds, "NX")
      .ttl(key)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? rule.windowSeconds);
    return {
      allowed: count <= rule.limit,
      count,
      retryAfterSeconds: Math.max(ttl, 1),
    };
  }

  /** True when the counter is already at or over the limit (does not count a hit). */
  async isBlocked(
    name: RateLimitName,
    subject: string,
  ): Promise<RateLimitResult> {
    const rule: RateRule = RATE_LIMITS[name];
    const key = this.key(name, subject);
    const [count, ttl] = await Promise.all([
      this.redis.get(key),
      this.redis.ttl(key),
    ]);
    const n = Number(count ?? 0);
    return {
      allowed: n < rule.limit,
      count: n,
      retryAfterSeconds: Math.max(ttl, 1),
    };
  }

  async reset(name: RateLimitName, subject: string): Promise<void> {
    await this.redis.del(this.key(name, subject));
  }

  /** Counts a hit and throws RATE_LIMITED when over the limit. */
  async consume(name: RateLimitName, subject: string): Promise<void> {
    const result = await this.hit(name, subject);
    if (!result.allowed) {
      throw rateLimitedError(result.retryAfterSeconds);
    }
  }
}

export function rateLimitedError(retryAfterSeconds: number): AppError {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return new AppError(
    "RATE_LIMITED",
    `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    { details: { retryAfterSeconds } },
  );
}
