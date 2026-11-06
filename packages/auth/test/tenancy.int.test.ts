import type { AuthContext } from "@gym/core/authz";
import { FEATURES, noEntitlementCache } from "@gym/core/entitlements";
import { isAppError, type ErrorCode } from "@gym/core/errors";
import {
  addOverride,
  changeTenantStatus,
  createTenantByPlatform,
  expireDueTrials,
  getSupportSnapshot,
  endSupportSession,
  startSupportSession,
  type PlatformContext,
  type PlatformDeps,
} from "@gym/core/platform";
import {
  acceptInvitation,
  createBranch,
  createTenantForOwner,
  getBranch,
  guard,
  inviteStaff,
  listBranches,
  listMyTenants,
  listStaff,
  loadTenantAccess,
  setBranchArchived,
  setStaffActive,
  updateBranch,
  updateTaxSettings,
  type CoreDeps,
  type InvitationMailer,
} from "@gym/core/tenancy";
import {
  createPrismaClient,
  GLOBAL_APP_MODELS,
  TENANT_MODELS,
  withTenant,
  type PrismaClient,
} from "@gym/db";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsFor, platformPermissionsFor } from "../src/permissions";

let db: TestDatabase;
let app: PrismaClient;
let platform: PrismaClient;
let owner: PrismaClient;
let deps: CoreDeps;
let pdeps: PlatformDeps;
const sentInvites: { to: string; token: string }[] = [];
const mailer: InvitationMailer = async (m) => {
  sentInvites.push({ to: m.to, token: m.token });
};

/** Snake-case table names for the registry's tenant models. */
/** Tables whose @@map isn't the plain snake_case of the model name. */
const TABLE_NAMES: Record<string, string> = {
  WhatsAppAccount: "whatsapp_account",
};
const tableOf = (model: string) =>
  TABLE_NAMES[model] ?? model.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

async function makeUser(email: string, name = email.split("@")[0]!) {
  return app.user.create({ data: { email, name, emailVerified: true } });
}

/** What packages/auth builds per request: verified membership → grants. */
async function ctxFor(userId: string, tenantId: string): Promise<AuthContext> {
  const access = await loadTenantAccess(app, userId, tenantId);
  if (!access) throw new Error(`no access for ${userId} in ${tenantId}`);
  return {
    userId,
    tenantId,
    membershipId: access.membershipId,
    grants: grantsFor(access.roles),
    activeBranchId: null,
    tenantStatus: access.tenant.status,
    subscriptionStatus: access.subscription?.status ?? null,
    timezone: access.tenant.timezone,
  };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) {
      expect(err.code).toBe(code);
      return err;
    }
    throw err;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

const superAdmin = (id: string): PlatformContext => ({
  platformUserId: id,
  role: "SUPER_ADMIN",
  permissions: platformPermissionsFor("SUPER_ADMIN"),
});

let platformUserId: string;
let A: { tenantId: string; ownerId: string; main: string; second?: string };
let B: { tenantId: string; ownerId: string; main: string };

beforeAll(async () => {
  db = await createTestDatabase();
  app = createPrismaClient(db.appUrl);
  platform = createPrismaClient(db.platformUrl);
  owner = createPrismaClient(db.ownerUrl);
  deps = { db: app, entitlements: noEntitlementCache };
  pdeps = { db: platform, entitlements: noEntitlementCache };

  platformUserId = (
    await platform.platformUser.create({
      data: {
        email: "ops@platform.test",
        name: "Ops",
        role: "SUPER_ADMIN",
        emailVerified: true,
      },
    })
  ).id;

  // Both tenants created through the real onboarding service, as gym_app (RLS on).
  const ownerA = await makeUser("owner@a.test");
  const ownerB = await makeUser("owner@b.test");
  const a = await createTenantForOwner(
    deps,
    { userId: ownerA.id },
    { gymName: "Alpha Gym", stateCode: "08", branchName: "Alpha Main" },
  );
  const b = await createTenantForOwner(
    deps,
    { userId: ownerB.id },
    { gymName: "Beta Gym", stateCode: "27", branchName: "Beta Main" },
  );
  const branchOf = async (tenantId: string) =>
    withTenant(
      app,
      tenantId,
      async (tx) => (await tx.branch.findFirstOrThrow()).id,
    );
  A = {
    tenantId: a.tenantId,
    ownerId: ownerA.id,
    main: await branchOf(a.tenantId),
  };
  B = {
    tenantId: b.tenantId,
    ownerId: ownerB.id,
    main: await branchOf(b.tenantId),
  };
  // Give A room for a second branch (starter allows 1).
  await owner.$executeRaw`UPDATE platform.tenant_subscription SET plan_id = (SELECT id FROM platform.saas_plan WHERE code = 'growth' AND version = 1) WHERE tenant_id = ${A.tenantId}::uuid`;
  const ctxA = await ctxFor(A.ownerId, A.tenantId);
  A.second = (
    await createBranch(deps, ctxA, {
      name: "Alpha East",
      code: "A-2",
      stateCode: "08",
    })
  ).id;
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
  await owner?.$disconnect();
  await db?.drop();
});

describe("onboarding", () => {
  it("creates tenant, trial subscription, settings, branch, owner membership and audit in one go", async () => {
    const tenant = await platform.tenant.findUniqueOrThrow({
      where: { id: A.tenantId },
      include: { subscription: true },
    });
    expect(tenant.status).toBe("ACTIVE");
    expect(tenant.subscription?.status).toBe("TRIALING");
    expect(tenant.subscription?.trialEndsAt?.getTime()).toBeGreaterThan(
      Date.now() + 13 * 86_400_000,
    );
    const access = await loadTenantAccess(app, A.ownerId, A.tenantId);
    expect(access?.roles).toEqual([{ roleKey: "GYM_OWNER", branchId: null }]);
    const audit = await withTenant(app, A.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: "tenant.created" } }),
    );
    expect(audit).toHaveLength(1);
    const usage = await platform.usageCounter.findMany({
      where: { tenantId: A.tenantId },
    });
    expect(Object.fromEntries(usage.map((u) => [u.key, u.value]))).toEqual({
      "branches.max": 2,
      "staff.max": 1,
    });
  });

  it("starts as PENDING_APPROVAL when the platform requires approval; approval starts the trial", async () => {
    await owner.$executeRaw`UPDATE platform.platform_setting SET value = 'true' WHERE key = 'tenant.approval_required'`;
    try {
      const u = await makeUser("pending@c.test");
      const created = await createTenantForOwner(
        deps,
        { userId: u.id },
        { gymName: "Gamma Gym", stateCode: "07", branchName: "Main" },
      );
      expect(created.status).toBe("PENDING_APPROVAL");
      const ctx = await ctxFor(u.id, created.tenantId);
      await expectCode(
        createBranch(deps, ctx, { name: "X", code: "XX", stateCode: "07" }),
        "SUBSCRIPTION_INACTIVE",
      );
      let sub = await platform.tenantSubscription.findUniqueOrThrow({
        where: { tenantId: created.tenantId },
      });
      expect(sub.trialEndsAt).toBeNull();
      await changeTenantStatus(
        pdeps,
        superAdmin(platformUserId),
        created.tenantId,
        "approve",
        "",
      );
      sub = await platform.tenantSubscription.findUniqueOrThrow({
        where: { tenantId: created.tenantId },
      });
      expect(sub.trialEndsAt).not.toBeNull();
      expect(
        (
          await platform.tenant.findUniqueOrThrow({
            where: { id: created.tenantId },
          })
        ).status,
      ).toBe("ACTIVE");
    } finally {
      await owner.$executeRaw`UPDATE platform.platform_setting SET value = 'false' WHERE key = 'tenant.approval_required'`;
    }
  });
});

describe("isolation, service layer", () => {
  it("a tenant only lists its own branches", async () => {
    const branches = await listBranches(
      deps,
      await ctxFor(A.ownerId, A.tenantId),
    );
    expect(branches.map((b) => b.id).sort()).toEqual([A.main, A.second].sort());
  });

  it("tenant A cannot read, update or archive tenant B's branch, even with its id", async () => {
    const ctxA = await ctxFor(A.ownerId, A.tenantId);
    await expectCode(getBranch(deps, ctxA, B.main), "NOT_FOUND");
    await expectCode(
      updateBranch(deps, ctxA, B.main, {
        name: "Hacked",
        code: "HAX",
        stateCode: "27",
      }),
      "NOT_FOUND",
    );
    await expectCode(setBranchArchived(deps, ctxA, B.main, true), "NOT_FOUND");
    const still = await withTenant(app, B.tenantId, (tx) =>
      tx.branch.findUniqueOrThrow({ where: { id: B.main } }),
    );
    expect(still.name).toBe("Beta Main");
    expect(still.status).toBe("ACTIVE");
  });

  it("a user gets no context for a tenant they don't belong to (client-supplied tenant id is never trusted)", async () => {
    expect(await loadTenantAccess(app, A.ownerId, B.tenantId)).toBeNull();
  });

  it("the scoping extension refuses to write a row for another tenant", async () => {
    await expect(
      withTenant(app, A.tenantId, (tx) =>
        tx.branch.create({
          data: {
            tenantId: B.tenantId,
            name: "x",
            code: "ZZ",
            stateCode: "27",
          },
        }),
      ),
    ).rejects.toThrow(/tenantId does not match/);
  });
});

describe("isolation, database layer (RLS as gym_app)", () => {
  const tenantTables = TENANT_MODELS.map(tableOf);

  it("every tenant-owned table has RLS enabled and a policy", async () => {
    const rows = await owner.$queryRaw<
      { relname: string; rls: boolean; policies: bigint }[]
    >`
      SELECT c.relname, c.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind = 'r'`;
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const table of tenantTables) {
      expect(byName.get(table)?.rls, table).toBe(true);
      expect(Number(byName.get(table)?.policies ?? 0), table).toBeGreaterThan(
        0,
      );
    }
    // Every app table is either tenant-owned (with RLS) or a registered global identity table.
    const known = new Set([...tenantTables, ...GLOBAL_APP_MODELS.map(tableOf)]);
    for (const row of rows)
      expect(known.has(row.relname), row.relname).toBe(true);
  });

  it("raw SQL inside tenant A sees no row of tenant B in any tenant table", async () => {
    for (const table of tenantTables) {
      const rows = await withTenant(app, A.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM app."${table}" WHERE tenant_id = $1::uuid`,
          B.tenantId,
        ),
      );
      expect(Number(rows[0]?.n), table).toBe(0);
    }
  });

  it("raw UPDATE and DELETE of tenant B rows from tenant A affect nothing", async () => {
    const [updated, deleted] = await withTenant(app, A.tenantId, async (tx) => [
      await tx.$executeRaw`UPDATE app.branch SET name = 'pwned' WHERE id = ${B.main}::uuid`,
      await tx.$executeRaw`DELETE FROM app.tenant_settings WHERE tenant_id = ${B.tenantId}::uuid`,
    ]);
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
  });

  it("audit logs are append-only for the application role", async () => {
    await expect(
      withTenant(
        app,
        A.tenantId,
        (tx) => tx.$executeRaw`DELETE FROM app.audit_log`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(
        app,
        A.tenantId,
        (tx) => tx.$executeRaw`UPDATE app.audit_log SET action = 'x'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("raw INSERT tagged with tenant B is rejected inside tenant A", async () => {
    await expect(
      withTenant(
        app,
        A.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.branch (id, tenant_id, name, code, state_code, status, created_at, updated_at)
          VALUES (gen_random_uuid(), ${B.tenantId}::uuid, 'x', 'QQ', '27', 'ACTIVE', now(), now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("with no tenant set, tenant tables are empty and other tenants' platform rows are hidden", async () => {
    const [branches, tenants, subs] = await app.$transaction([
      app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM app.branch`,
      app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM platform.tenant`,
      app.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM platform.tenant_subscription`,
    ]);
    expect(Number(branches[0]?.n)).toBe(0);
    expect(Number(tenants[0]?.n)).toBe(0);
    expect(Number(subs[0]?.n)).toBe(0);
  });

  it("gym_app cannot change another tenant's profile in platform.tenant", async () => {
    const n = await withTenant(
      app,
      A.tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE platform.tenant SET display_name = 'pwned' WHERE id = ${B.tenantId}::uuid`,
    );
    expect(n).toBe(0);
  });
});

describe("realm separation (DB roles)", () => {
  it("gym_platform cannot select from any app table", async () => {
    const client = new pg.Client({ connectionString: db.platformUrl });
    await client.connect();
    try {
      for (const table of [...TENANT_MODELS, ...GLOBAL_APP_MODELS].map(
        tableOf,
      )) {
        await expect(
          client.query(`SELECT 1 FROM app."${table}" LIMIT 1`),
          table,
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });

  it("gym_app cannot read platform accounts, sessions or the platform audit log", async () => {
    const client = new pg.Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      for (const table of [
        "platform_user",
        "platform_session",
        "platform_account",
        "platform_otp_challenge",
        "platform_audit_log",
      ]) {
        await expect(
          client.query(`SELECT 1 FROM platform."${table}" LIMIT 1`),
          table,
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });
});

describe("branch-scoped roles", () => {
  let managerCtx: AuthContext;

  beforeAll(async () => {
    const manager = await makeUser("manager@a.test");
    await withTenant(app, A.tenantId, async (tx) => {
      const m = await tx.tenantMembership.create({
        data: { tenantId: A.tenantId, userId: manager.id },
      });
      await tx.roleAssignment.create({
        data: {
          tenantId: A.tenantId,
          membershipId: m.id,
          roleKey: "BRANCH_MANAGER",
          branchId: A.main,
        },
      });
    });
    managerCtx = await ctxFor(manager.id, A.tenantId);
  });

  it("sees only their branch", async () => {
    expect((await listBranches(deps, managerCtx)).map((b) => b.id)).toEqual([
      A.main,
    ]);
    await expectCode(getBranch(deps, managerCtx, A.second!), "FORBIDDEN");
  });

  it("cannot invite staff to another branch, or grant tenant-wide roles", async () => {
    await expectCode(
      inviteStaff(deps, mailer, managerCtx, {
        email: "x@a.test",
        roles: [{ roleKey: "RECEPTIONIST", branchId: A.second }],
      }),
      "FORBIDDEN",
    );
    await expectCode(
      inviteStaff(deps, mailer, managerCtx, {
        email: "x@a.test",
        roles: [{ roleKey: "GYM_ADMIN", branchId: null }],
      }),
      "FORBIDDEN",
    );
  });

  it("cannot manage branches or tax settings", async () => {
    await expectCode(
      createBranch(deps, managerCtx, {
        name: "Nope",
        code: "NO",
        stateCode: "08",
      }),
      "FORBIDDEN",
    );
    await expectCode(
      updateTaxSettings(deps, managerCtx, { stateCode: "08" }),
      "FORBIDDEN",
    );
  });
});

describe("invitations (D-04 global identity)", () => {
  it("accepting links an existing global user, who keeps their other gym", async () => {
    // Riya is already in tenant B.
    const riya = await makeUser("riya@x.test", "Riya");
    await withTenant(app, B.tenantId, async (tx) => {
      const m = await tx.tenantMembership.create({
        data: { tenantId: B.tenantId, userId: riya.id },
      });
      await tx.roleAssignment.create({
        data: {
          tenantId: B.tenantId,
          membershipId: m.id,
          roleKey: "MEMBER",
          branchId: B.main,
        },
      });
    });
    const ctxA = await ctxFor(A.ownerId, A.tenantId);
    await inviteStaff(deps, mailer, ctxA, {
      email: "Riya@X.test",
      roles: [{ roleKey: "TRAINER", branchId: A.second }],
    });
    const invite = sentInvites.find((i) => i.to === "riya@x.test")!;
    expect(invite).toBeDefined();

    const result = await acceptInvitation(
      deps,
      { id: riya.id, email: riya.email, emailVerified: true },
      invite.token,
    );
    expect(result.tenantId).toBe(A.tenantId);
    const mine = await listMyTenants(app, riya.id);
    expect(mine.map((t) => t.tenantId).sort()).toEqual(
      [A.tenantId, B.tenantId].sort(),
    );
    expect(await app.user.count({ where: { email: "riya@x.test" } })).toBe(1);
    const access = await loadTenantAccess(app, riya.id, A.tenantId);
    expect(access?.roles).toEqual([{ roleKey: "TRAINER", branchId: A.second }]);

    // Single use.
    await expectCode(
      acceptInvitation(
        deps,
        { id: riya.id, email: riya.email, emailVerified: true },
        invite.token,
      ),
      "CONFLICT",
    );
  });

  it("refuses a different email, an unverified email and an expired invitation", async () => {
    const ctxA = await ctxFor(A.ownerId, A.tenantId);
    await inviteStaff(deps, mailer, ctxA, {
      email: "sam@a.test",
      roles: [{ roleKey: "RECEPTIONIST", branchId: A.main }],
    });
    const token = sentInvites.find((i) => i.to === "sam@a.test")!.token;
    const other = await makeUser("mallory@a.test");
    await expectCode(
      acceptInvitation(
        deps,
        { id: other.id, email: other.email, emailVerified: true },
        token,
      ),
      "FORBIDDEN",
    );
    const sam = await makeUser("sam@a.test");
    await expectCode(
      acceptInvitation(
        deps,
        { id: sam.id, email: sam.email, emailVerified: false },
        token,
      ),
      "FORBIDDEN",
    );
    await owner.$executeRaw`UPDATE app.invitation SET expires_at = now() - interval '1 minute' WHERE email = 'sam@a.test'`;
    await expectCode(
      acceptInvitation(
        deps,
        { id: sam.id, email: sam.email, emailVerified: true },
        token,
      ),
      "CONFLICT",
    );
  });

  it("a deactivated staff member loses access at once and frees a staff seat", async () => {
    const ctxA = await ctxFor(A.ownerId, A.tenantId);
    const { staff } = await listStaff(deps, ctxA);
    const riya = staff.find((s) => s.email === "riya@x.test")!;
    const before = await platform.usageCounter.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: A.tenantId, key: "staff.max" } },
    });
    await setStaffActive(deps, ctxA, riya.membershipId, false);
    expect(await loadTenantAccess(app, riya.userId, A.tenantId)).toBeNull();
    const after = await platform.usageCounter.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: A.tenantId, key: "staff.max" } },
    });
    expect(after.value).toBe(before.value - 1);
    await setStaffActive(deps, ctxA, riya.membershipId, true);
    expect(await loadTenantAccess(app, riya.userId, A.tenantId)).not.toBeNull();
  });
});

describe("platform-created tenant", () => {
  it("admin creates the tenant and invites the owner, who accepts and can set up a branch", async () => {
    const ownerMails: { to: string; token: string }[] = [];
    const tenant = await createTenantByPlatform(
      pdeps,
      async (m) => {
        ownerMails.push({ to: m.to, token: m.token });
      },
      superAdmin(platformUserId),
      {
        displayName: "Delta Gym",
        ownerEmail: "Owner@Delta.test",
        planCode: "starter",
      },
    );
    expect(tenant.status).toBe("ACTIVE");
    const sub = await platform.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(sub.status).toBe("TRIALING");
    expect(ownerMails[0]?.to).toBe("owner@delta.test");

    const owner = await makeUser("owner@delta.test");
    const { tenantId } = await acceptInvitation(
      deps,
      { id: owner.id, email: owner.email, emailVerified: true },
      ownerMails[0]!.token,
    );
    expect(tenantId).toBe(tenant.id);
    const ctx = await ctxFor(owner.id, tenant.id);
    expect(ctx.grants.map((g) => g.roleKey)).toEqual(["GYM_OWNER"]);
    const branch = await createBranch(deps, ctx, {
      name: "Delta Main",
      code: "MAIN",
      stateCode: "29",
    });
    expect(branch.tenantId).toBe(tenant.id);
    const contacts = await platform.$queryRaw<{ email: string }[]>`
      SELECT email FROM platform_api.tenant_owner_contacts(${tenant.id}::uuid)`;
    expect(contacts.map((c) => c.email)).toEqual(["owner@delta.test"]);
  });
});

describe("check order: subscription → entitlement (402) → permission (403) → quota (402)", () => {
  it("runs in the documented order on a sample protected action", async () => {
    // A trainer in tenant B (starter plan: no CRM). Trainers lack leads.manage.
    const trainer = await makeUser("trainer@b.test");
    await withTenant(app, B.tenantId, async (tx) => {
      const m = await tx.tenantMembership.create({
        data: { tenantId: B.tenantId, userId: trainer.id },
      });
      await tx.roleAssignment.create({
        data: {
          tenantId: B.tenantId,
          membershipId: m.id,
          roleKey: "TRAINER",
          branchId: B.main,
        },
      });
    });
    const protectedAction = async () =>
      guard(deps, await ctxFor(trainer.id, B.tenantId), {
        permission: "leads.manage",
        entitlement: "crm.enabled",
        write: true,
        branchId: B.main,
      });

    // Both the entitlement and the permission are missing: entitlement wins (402).
    const first = await expectCode(protectedAction(), "ENTITLEMENT_REQUIRED");
    expect(first.status).toBe(402);

    // With the feature granted, the permission check now fails (403).
    await addOverride(pdeps, superAdmin(platformUserId), B.tenantId, {
      featureKey: "crm.enabled",
      value: "true",
      reason: "pilot customer",
    });
    const second = await expectCode(protectedAction(), "FORBIDDEN");
    expect(second.status).toBe(403);

    // Quota comes last: the owner (has permission) hits the starter plan's branch limit.
    const ownerB = await ctxFor(B.ownerId, B.tenantId);
    const third = await expectCode(
      createBranch(deps, ownerB, {
        name: "Beta 2",
        code: "B-2",
        stateCode: "27",
      }),
      "QUOTA_EXCEEDED",
    );
    expect(third.status).toBe(402);
  });
});

describe("suspension and trial expiry", () => {
  it("a suspended tenant can read but not write; reactivation restores writes", async () => {
    const admin = superAdmin(platformUserId);
    await changeTenantStatus(
      pdeps,
      admin,
      B.tenantId,
      "suspend",
      "Chargeback investigation",
    );
    const ctx = await ctxFor(B.ownerId, B.tenantId);
    expect(ctx.tenantStatus).toBe("SUSPENDED");
    await expectCode(
      updateTaxSettings(deps, ctx, { stateCode: "27" }),
      "SUBSCRIPTION_INACTIVE",
    );
    expect(await listBranches(deps, ctx)).toHaveLength(1);
    // The owner sees the platform action in their own audit log.
    const audit = await withTenant(app, B.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { actorType: "PLATFORM" } }),
    );
    expect(audit.map((a) => a.action)).toContain("platform.tenant_suspended");
    await changeTenantStatus(
      pdeps,
      admin,
      B.tenantId,
      "reactivate",
      "Resolved with the owner",
    );
    await updateTaxSettings(deps, await ctxFor(B.ownerId, B.tenantId), {
      stateCode: "27",
    });
  });

  it("the trial expiry job moves a lapsed trial to the configured status, and the tenant becomes read-only", async () => {
    await owner.$executeRaw`UPDATE platform.tenant_subscription SET trial_ends_at = now() - interval '1 hour' WHERE tenant_id = ${A.tenantId}::uuid`;
    const expired = await expireDueTrials(pdeps);
    expect(expired).toEqual([A.tenantId]);
    const ctx = await ctxFor(A.ownerId, A.tenantId);
    expect(ctx.subscriptionStatus).toBe("SUSPENDED");
    await expectCode(
      createBranch(deps, ctx, { name: "Late", code: "LT", stateCode: "08" }),
      "SUBSCRIPTION_INACTIVE",
    );
    // Idempotent: a second run finds nothing.
    expect(await expireDueTrials(pdeps)).toEqual([]);
  });
});

describe("support sessions", () => {
  it("gives a read-only snapshot while open, logs it on both sides, and refuses once ended", async () => {
    const admin = superAdmin(platformUserId);
    const session = await startSupportSession(pdeps, admin, B.tenantId, {
      reason: "Ticket 42: branch missing",
      minutes: 30,
    });
    const { snapshot } = await getSupportSnapshot(pdeps, admin, session.id);
    expect(snapshot?.branches.map((b) => b.code)).toEqual(["MAIN"]);
    const tenantAudit = await withTenant(app, B.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { action: "platform.support_session_started" },
      }),
    );
    expect(tenantAudit).toHaveLength(1);
    // The tenant sees the open session (in-app notice).
    expect(
      (await loadTenantAccess(app, B.ownerId, B.tenantId))
        ?.activeSupportSessions,
    ).toHaveLength(1);
    await endSupportSession(pdeps, admin, session.id);
    await expectCode(getSupportSnapshot(pdeps, admin, session.id), "FORBIDDEN");
    await expect(
      platform.$queryRaw`SELECT platform_api.support_tenant_snapshot(${session.id}::uuid, ${platformUserId}::uuid)`,
    ).rejects.toThrow(/not active/);
  });

  it("refuses more than two hours", async () => {
    await expectCode(
      startSupportSession(pdeps, superAdmin(platformUserId), B.tenantId, {
        reason: "Too long please",
        minutes: 180,
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("catalog", () => {
  it("the feature keys in code match the database catalog", async () => {
    const rows = await platform.feature.findMany({
      select: { key: true, type: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.key, r.type]))).toEqual(
      FEATURES,
    );
  });
});
