import { createRedisConnection } from "@gym/core/jobs";
import { createPrismaClient, type PrismaClient } from "@gym/db";
import { MemoryEmailSender } from "@gym/integrations/email";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformAuth,
  resolvePlatformSession,
  upsertPlatformUser,
} from "../src/platform";
import { RATE_LIMITS, RateLimiter } from "../src/rate-limit";
import {
  createTenantAuth,
  resolveTenantSession,
  upsertPasswordUser,
} from "../src/tenant";

// Redis logical database 15, so development data is never touched.
function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  url.pathname = "/15";
  return url.toString();
}

const TENANT_SECRET = "test-tenant-secret-0123456789abcdefghij";
const PLATFORM_SECRET = "test-platform-secret-0123456789abcdefgh";
const PASSWORD = "correct-horse-battery";

let db: TestDatabase;
let app: PrismaClient;
let platform: PrismaClient;
let redis: Redis;
const email = new MemoryEmailSender();

let tenantAuth: ReturnType<typeof createTenantAuth>;
let platformAuth: ReturnType<typeof createPlatformAuth>;

function headersFrom(ip: string, cookie?: string) {
  const h = new Headers({ "x-forwarded-for": ip, "user-agent": "vitest" });
  if (cookie) h.set("cookie", cookie);
  return h;
}

/** Turns Set-Cookie response headers into a Cookie request header. */
function cookieFrom(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  platform = createPrismaClient(db.platformUrl);
  redis = createRedisConnection(testRedisUrl());
  await redis.flushdb();
  tenantAuth = createTenantAuth({
    db: app,
    secret: TENANT_SECRET,
    baseURL: "http://localhost:3000",
    brand: "Test Gym",
    email,
    limiter: new RateLimiter(redis, "test:rl:tenant"),
  });
  platformAuth = createPlatformAuth({
    db: platform,
    secret: PLATFORM_SECRET,
    baseURL: "http://localhost:3001",
    brand: "Test Gym",
    email,
    limiter: new RateLimiter(redis, "test:rl:platform"),
  });
  await upsertPasswordUser(app, {
    email: "staff@a.test",
    name: "Staff",
    password: PASSWORD,
  });
  await upsertPlatformUser(platform, {
    email: "ops@platform.test",
    name: "Ops",
    password: PASSWORD,
    role: "SUPER_ADMIN",
  });
});

afterAll(async () => {
  await redis?.flushdb();
  redis?.disconnect();
  await app?.$disconnect();
  await platform?.$disconnect();
  await db?.drop();
});

describe("RateLimiter", () => {
  it("allows up to the limit in a window, then blocks with a retry time", async () => {
    const limiter = new RateLimiter(redis, "test:rl:unit");
    const { limit } = RATE_LIMITS["reset:account"];
    for (let i = 0; i < limit; i++)
      expect((await limiter.hit("reset:account", "u1")).allowed).toBe(true);
    const blocked = await limiter.hit("reset:account", "u1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Other subjects are unaffected.
    expect((await limiter.hit("reset:account", "u2")).allowed).toBe(true);
    await expect(limiter.consume("reset:account", "u1")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  });
});

describe("tenant realm sign-in", () => {
  it("locks the account after repeated wrong passwords, even for the right one", async () => {
    const { limit } = RATE_LIMITS["signin-fail:account"];
    for (let i = 0; i < limit; i++) {
      await expect(
        tenantAuth.api.signInEmail({
          body: { email: "staff@a.test", password: "wrong-password!!" },
          headers: headersFrom(`10.0.0.${i}`),
        }),
      ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    }
    await expect(
      tenantAuth.api.signInEmail({
        body: { email: "staff@a.test", password: PASSWORD },
        headers: headersFrom("10.0.1.1"),
      }),
    ).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
    await redis.del("test:rl:tenant:signin-fail:account:staff@a.test");
  });

  it("limits sign-in attempts per IP", async () => {
    const { limit } = RATE_LIMITS["signin:ip"];
    const ip = "10.9.9.9";
    for (let i = 0; i < limit; i++) {
      await tenantAuth.api
        .signInEmail({
          body: { email: `nobody${i}@a.test`, password: "whatever-123" },
          headers: headersFrom(ip),
        })
        .catch(() => {});
    }
    await expect(
      tenantAuth.api.signInEmail({
        body: { email: "staff@a.test", password: PASSWORD },
        headers: headersFrom(ip),
      }),
    ).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
  });

  it("a tenant session is never valid in the platform realm, and vice versa", async () => {
    const tenantRes = await tenantAuth.api.signInEmail({
      body: { email: "staff@a.test", password: PASSWORD },
      headers: headersFrom("10.1.0.1"),
      returnHeaders: true,
    });
    const tenantCookie = cookieFrom(tenantRes.headers);
    expect(tenantCookie).toMatch(/^gym\.session_token=/);
    expect(
      await tenantAuth.api.getSession({
        headers: headersFrom("10.1.0.1", tenantCookie),
      }),
    ).not.toBeNull();
    expect(
      await platformAuth.api.getSession({
        headers: headersFrom("10.1.0.1", tenantCookie),
      }),
    ).toBeNull();

    const platformRes = await platformAuth.api.signInEmail({
      body: { email: "ops@platform.test", password: PASSWORD },
      headers: headersFrom("10.1.0.2"),
      returnHeaders: true,
    });
    const platformCookie = cookieFrom(platformRes.headers);
    expect(platformCookie).toMatch(/^gymadmin\.session_token=/);
    expect(
      await tenantAuth.api.getSession({
        headers: headersFrom("10.1.0.2", platformCookie),
      }),
    ).toBeNull();

    // Even with the tenant cookie renamed to the platform name, the platform realm rejects it
    // (different secret, different session table).
    const forged = tenantCookie.replace(/^gym\./, "gymadmin.");
    expect(
      await platformAuth.api.getSession({
        headers: headersFrom("10.1.0.1", forged),
      }),
    ).toBeNull();
  });

  it("a signed-in tenant user with no gym is sent to onboarding/picker, not into a tenant", async () => {
    const res = await tenantAuth.api.signInEmail({
      body: { email: "staff@a.test", password: PASSWORD },
      headers: headersFrom("10.2.0.1"),
      returnHeaders: true,
    });
    const state = await resolveTenantSession({
      auth: tenantAuth,
      db: app,
      headers: headersFrom("10.2.0.1", cookieFrom(res.headers)),
    });
    expect(state.kind).toBe("no-tenant");
  });
});

describe("platform realm", () => {
  it("has no self-signup", async () => {
    await expect(
      platformAuth.api.signUpEmail({
        body: {
          email: "intruder@platform.test",
          password: "intruder-password-1",
          name: "X",
        },
        headers: headersFrom("10.3.0.1"),
      }),
    ).rejects.toBeTruthy();
    expect(
      await platform.platformUser.count({
        where: { email: "intruder@platform.test" },
      }),
    ).toBe(0);
  });

  it("requires the email OTP after the password", async () => {
    const res = await platformAuth.api.signInEmail({
      body: { email: "ops@platform.test", password: PASSWORD },
      headers: headersFrom("10.3.0.2"),
      returnHeaders: true,
    });
    const state = await resolvePlatformSession({
      auth: platformAuth,
      db: platform,
      headers: headersFrom("10.3.0.2", cookieFrom(res.headers)),
    });
    expect(state.kind).toBe("mfa-required");
  });
});
