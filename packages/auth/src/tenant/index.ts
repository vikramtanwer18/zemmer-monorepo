import { createHash, randomBytes } from "node:crypto";
import { mfaRequirement, roleKeys, type AuthContext } from "@gym/core/authz";
import {
  listMyTenants,
  loadTenantAccess,
  type MyTenant,
  type TenantAccess,
} from "@gym/core/tenancy";
import type { PrismaClient } from "@gym/db";
import {
  otpEmail,
  resetPasswordEmail,
  verifyEmailEmail,
  type EmailSender,
} from "@gym/integrations/email";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { OtpService, type OtpStore } from "../otp";
import { grantsFor } from "../permissions";
import type { RateLimiter } from "../rate-limit";
import { rateLimitHooks } from "../shared";

export const TENANT_COOKIE_PREFIX = "gym";
export const TRUSTED_DEVICE_COOKIE = "gym_trusted_device";
export const TRUSTED_DEVICE_DAYS = 30;

export type TenantAuthOptions = {
  db: PrismaClient;
  secret: string;
  baseURL: string;
  brand: string;
  email: EmailSender;
  limiter: RateLimiter;
  google?: { clientId: string; clientSecret: string } | null;
};

/** Better Auth for the tenant realm (apps/web): staff, owners and members. */
export function createTenantAuth(options: TenantAuthOptions) {
  const { db, email, brand } = options;
  return betterAuth({
    appName: brand,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    database: prismaAdapter(db, { provider: "postgresql" }),
    telemetry: { enabled: false },
    // Our Redis limiter runs in hooks (per IP and per account); Better Auth's is memory-only.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: TENANT_COOKIE_PREFIX,
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await email.send({
          to: user.email,
          ...resetPasswordEmail({ brand, url }),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await email.send({
          to: user.email,
          ...verifyEmailEmail({ brand, name: user.name, url }),
        });
      },
    },
    socialProviders: options.google
      ? {
          google: {
            clientId: options.google.clientId,
            clientSecret: options.google.clientSecret,
            prompt: "select_account",
          },
        }
      : {},
    account: {
      // Google proves the email, so it may link to an existing password account (one User per email, D-04).
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    // Sessions carry tenant/branch/MFA state that we manage ourselves; nobody else edits them.
    disabledPaths: ["/update-session", "/delete-user", "/change-email"],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (user?.status === "DEACTIVATED") {
              throw new APIError("FORBIDDEN", {
                message: "This account has been deactivated.",
              });
            }
          },
        },
      },
    },
    hooks: rateLimitHooks(options.limiter),
    plugins: [nextCookies()],
  });
}

export type TenantAuth = ReturnType<typeof createTenantAuth>;

// --- second factor -------------------------------------------------------------------

export function tenantOtpStore(db: PrismaClient): OtpStore {
  return {
    latest: (sessionId) =>
      db.otpChallenge.findFirst({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
      }),
    create: async (row) => {
      await db.otpChallenge.create({ data: row });
    },
    recordFailedAttempt: async (id) => {
      await db.otpChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
    },
    consume: async (id, now) => {
      const { count } = await db.otpChallenge.updateMany({
        where: { id, consumedAt: null },
        data: { consumedAt: now },
      });
      return count === 1;
    },
    markSessionVerified: async (sessionId, now) => {
      await db.session.update({
        where: { id: sessionId },
        data: { mfaVerifiedAt: now },
      });
    },
  };
}

export function createTenantOtp(options: {
  db: PrismaClient;
  secret: string;
  brand: string;
  email: EmailSender;
  limiter: RateLimiter;
}) {
  return new OtpService({
    store: tenantOtpStore(options.db),
    secret: options.secret,
    limiter: options.limiter,
    sendCode: (to, code, minutes) =>
      options.email.send({
        to,
        ...otpEmail({ brand: options.brand, code, minutes }),
      }),
  });
}

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** "Remember this device": returns the cookie value; only the hash is stored. */
export async function createTrustedDevice(
  db: PrismaClient,
  userId: string,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    now.getTime() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000,
  );
  await db.trustedDevice.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      userAgent: userAgent?.slice(0, 300),
      expiresAt,
    },
  });
  return { token, expiresAt };
}

async function isTrustedDevice(
  db: PrismaClient,
  userId: string,
  token: string | null | undefined,
  now: Date,
): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const device = await db.trustedDevice.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!device || device.userId !== userId || device.expiresAt <= now)
    return false;
  await db.trustedDevice.update({
    where: { id: device.id },
    data: { lastUsedAt: now },
  });
  return true;
}

// --- request state -------------------------------------------------------------------

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

export type SessionInfo = {
  id: string;
  activeTenantId: string | null;
  activeBranchId: string | null;
  mfaVerifiedAt: Date | null;
};

/** Where a request stands, from "not signed in" to "ready with an AuthContext". */
export type TenantSessionState =
  | { kind: "anonymous" }
  | { kind: "deactivated" }
  | {
      kind: "no-tenant";
      user: SessionUser;
      session: SessionInfo;
      tenants: MyTenant[];
    }
  | {
      kind: "pending-approval";
      user: SessionUser;
      session: SessionInfo;
      access: TenantAccess;
    }
  | {
      kind: "mfa-required";
      user: SessionUser;
      session: SessionInfo;
      access: TenantAccess;
      trustedDeviceAllowed: boolean;
    }
  | {
      kind: "ready";
      user: SessionUser;
      session: SessionInfo;
      access: TenantAccess;
      ctx: AuthContext;
      mfaRequired: boolean;
      trustedDeviceAllowed: boolean;
    };

/**
 * Resolves the request from the verified Better Auth session. The active tenant stored on the
 * session is re-verified against TenantMembership every time (D-04); nothing comes from the client.
 */
export async function resolveTenantSession(input: {
  auth: TenantAuth;
  db: PrismaClient;
  headers: Headers;
  trustedDeviceToken?: string | null;
  now?: Date;
}): Promise<TenantSessionState> {
  const now = input.now ?? new Date();
  const result = await input.auth.api.getSession({ headers: input.headers });
  if (!result) return { kind: "anonymous" };

  const [userRow, sessionRow] = await Promise.all([
    input.db.user.findUnique({ where: { id: result.user.id } }),
    input.db.session.findUnique({ where: { id: result.session.id } }),
  ]);
  if (!userRow || !sessionRow) return { kind: "anonymous" };
  if (userRow.status === "DEACTIVATED") return { kind: "deactivated" };

  const user: SessionUser = {
    id: userRow.id,
    name: userRow.name,
    email: userRow.email,
    emailVerified: userRow.emailVerified,
    image: userRow.image,
  };
  let session: SessionInfo = {
    id: sessionRow.id,
    activeTenantId: sessionRow.activeTenantId,
    activeBranchId: sessionRow.activeBranchId,
    mfaVerifiedAt: sessionRow.mfaVerifiedAt,
  };

  let access = session.activeTenantId
    ? await loadTenantAccess(input.db, user.id, session.activeTenantId, now)
    : null;
  if (access?.tenant.status === "CANCELLED") access = null;

  if (!access) {
    const tenants = await listMyTenants(input.db, user.id);
    if (tenants.length === 1 && tenants[0]) {
      access = await loadTenantAccess(
        input.db,
        user.id,
        tenants[0].tenantId,
        now,
      );
    }
    if (!access) {
      if (session.activeTenantId) {
        await input.db.session.update({
          where: { id: session.id },
          data: { activeTenantId: null, activeBranchId: null },
        });
      }
      return {
        kind: "no-tenant",
        user,
        session: { ...session, activeTenantId: null },
        tenants,
      };
    }
    session = await setActiveTenant(input.db, session.id, access.tenant.id);
  }

  if (access.tenant.status === "PENDING_APPROVAL") {
    return { kind: "pending-approval", user, session, access };
  }

  const roles = access.roles.map((r) => r.roleKey);
  const mfa = mfaRequirement(roles, access.require2faForStaff);
  if (mfa.required && !session.mfaVerifiedAt) {
    if (
      mfa.trustedDeviceAllowed &&
      (await isTrustedDevice(input.db, user.id, input.trustedDeviceToken, now))
    ) {
      await input.db.session.update({
        where: { id: session.id },
        data: { mfaVerifiedAt: now },
      });
      session = { ...session, mfaVerifiedAt: now };
    } else {
      return {
        kind: "mfa-required",
        user,
        session,
        access,
        trustedDeviceAllowed: mfa.trustedDeviceAllowed,
      };
    }
  }

  const grants = grantsFor(access.roles);
  const allBranches = access.roles.some((r) => r.branchId === null);
  const allowedBranchIds = new Set(
    access.branches
      .map((b) => b.id)
      .filter(
        (id) => allBranches || access.roles.some((r) => r.branchId === id),
      ),
  );
  const activeBranchId =
    session.activeBranchId && allowedBranchIds.has(session.activeBranchId)
      ? session.activeBranchId
      : null;

  const ctx: AuthContext = {
    userId: user.id,
    tenantId: access.tenant.id,
    membershipId: access.membershipId,
    grants,
    activeBranchId,
    tenantStatus: access.tenant.status,
    subscriptionStatus: access.subscription?.status ?? null,
    timezone: access.tenant.timezone,
    request: {
      ip: input.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: input.headers.get("user-agent"),
    },
  };
  return {
    kind: "ready",
    user,
    session: { ...session, activeBranchId },
    access,
    ctx,
    mfaRequired: mfa.required,
    trustedDeviceAllowed: mfa.trustedDeviceAllowed,
  };
}

async function setActiveTenant(
  db: PrismaClient,
  sessionId: string,
  tenantId: string,
) {
  const row = await db.session.update({
    where: { id: sessionId },
    data: { activeTenantId: tenantId, activeBranchId: null },
  });
  return {
    id: row.id,
    activeTenantId: row.activeTenantId,
    activeBranchId: row.activeBranchId,
    mfaVerifiedAt: row.mfaVerifiedAt,
  };
}

/** Switches the session's tenant after checking the membership. Returns false if not a member. */
export async function selectTenant(
  db: PrismaClient,
  userId: string,
  sessionId: string,
  tenantId: string,
): Promise<boolean> {
  const access = await loadTenantAccess(db, userId, tenantId);
  if (!access || access.tenant.status === "CANCELLED") return false;
  await setActiveTenant(db, sessionId, tenantId);
  return true;
}

/** Sets the header branch (null = all). Only branches the context may access. */
export async function selectBranch(
  db: PrismaClient,
  state: Extract<TenantSessionState, { kind: "ready" }>,
  branchId: string | null,
): Promise<boolean> {
  if (branchId !== null) {
    const allBranches = state.access.roles.some((r) => r.branchId === null);
    const exists = state.access.branches.some((b) => b.id === branchId);
    const allowed =
      allBranches || state.access.roles.some((r) => r.branchId === branchId);
    if (!exists || !allowed) return false;
  }
  await db.session.update({
    where: { id: state.session.id },
    data: { activeBranchId: branchId },
  });
  return true;
}

export { roleKeys };

/**
 * Creates (or resets the password of) a verified email+password user in the tenant realm.
 * Seeds and tests only; real users sign up through Better Auth.
 */
export async function upsertPasswordUser(
  db: PrismaClient,
  input: { email: string; name: string; password: string },
): Promise<{ id: string; created: boolean }> {
  const { hashPassword } = await import("better-auth/crypto");
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await tx.user.create({
        data: { email, name: input.name, emailVerified: true },
      }));
    const account = await tx.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });
    if (account) {
      await tx.account.update({
        where: { id: account.id },
        data: { password: passwordHash },
      });
    } else {
      await tx.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: passwordHash,
        },
      });
    }
    return { id: user.id, created: !existing };
  });
}
