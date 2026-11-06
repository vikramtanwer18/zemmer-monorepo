/**
 * Development/demo data: two gyms, a user for every role, one user who is staff at one gym
 * and a member at the other, and a Super Admin (M1); plans, members, invoices and payments, with
 * every MEMBER account linked to a member profile so it can open the member app (M2).
 *
 *   pnpm db:seed
 *
 * Passwords: SEED_DEMO_PASSWORD for gym users (a random one is generated and printed if unset);
 * the Super Admin is created only when SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set.
 * Safe to re-run: existing gyms and users are kept. Refuses to run in production.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { bumpUsage, noEntitlementCache } from "@gym/core/entitlements";
import { gstinCheckChar } from "@gym/core/gst";
import { createMember } from "@gym/core/members";
import { sellMembership } from "@gym/core/memberships";
import { createTenantForOwner } from "@gym/core/tenancy";
import { createPrismaClient, withTenant, type PrismaClient } from "@gym/db";
import { config as loadDotenv } from "dotenv";
import { authContextFor } from "../src/context";
import { upsertPlatformUser } from "../src/platform";
import { seedFloorDemo } from "./demo-floor";
import { seedCrmDemo } from "./demo-crm";
import { seedGrowthDemo } from "./demo-growth";
import { seedFitnessDemo } from "./demo-fitness";
import { seedIntelligenceDemo } from "./demo-intelligence";
import { seedGymPayments, seedPlatformPayments } from "./demo-payments";
import { seedDemoMembers } from "./demo-members";
import { upsertPasswordUser } from "../src/tenant";

loadDotenv({
  path: path.resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data: NODE_ENV is production.");
  process.exit(1);
}

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!ownerUrl || !platformUrl) {
  console.error(
    "MIGRATION_DATABASE_URL and PLATFORM_DATABASE_URL must be set.",
  );
  process.exit(1);
}

const generated = !process.env.SEED_DEMO_PASSWORD;
const password =
  process.env.SEED_DEMO_PASSWORD ||
  `Demo-${randomBytes(9).toString("base64url")}`;

type Role = { roleKey: string; branch: string | null };
type Person = { email: string; name: string; roles: Role[] };
type GymSeed = {
  name: string;
  slug: string;
  legalName: string;
  stateCode: string;
  planCode: string;
  branches: { code: string; name: string; city: string }[];
  owner: { email: string; name: string };
  people: Person[];
};

const IRON: GymSeed = {
  name: "Iron Temple Jaipur",
  slug: "iron-temple-jaipur",
  legalName: "Iron Temple Fitness LLP",
  stateCode: "08",
  planCode: "growth",
  branches: [
    { code: "MAIN", name: "C-Scheme", city: "Jaipur" },
    { code: "JPR-2", name: "Malviya Nagar", city: "Jaipur" },
  ],
  owner: { email: "owner@irontemple.test", name: "Arjun Mehta" },
  people: [
    {
      email: "admin@irontemple.test",
      name: "Kavya Sharma",
      roles: [{ roleKey: "GYM_ADMIN", branch: null }],
    },
    {
      email: "manager@irontemple.test",
      name: "Vikram Rathore",
      roles: [{ roleKey: "BRANCH_MANAGER", branch: "MAIN" }],
    },
    {
      email: "reception@irontemple.test",
      name: "Pooja Jain",
      roles: [{ roleKey: "RECEPTIONIST", branch: "MAIN" }],
    },
    {
      email: "sales@irontemple.test",
      name: "Rahul Verma",
      roles: [{ roleKey: "SALES_STAFF", branch: "JPR-2" }],
    },
    {
      email: "trainer@irontemple.test",
      name: "Sameer Khan",
      roles: [{ roleKey: "TRAINER", branch: "JPR-2" }],
    },
    {
      email: "accounts@irontemple.test",
      name: "Neha Agarwal",
      roles: [{ roleKey: "ACCOUNTANT", branch: null }],
    },
    {
      email: "member@irontemple.test",
      name: "Ankit Gupta",
      roles: [{ roleKey: "MEMBER", branch: "MAIN" }],
    },
    {
      email: "riya@example.test",
      name: "Riya Kapoor",
      roles: [{ roleKey: "RECEPTIONIST", branch: "JPR-2" }],
    },
  ],
};

const PULSE: GymSeed = {
  name: "Pulse Fitness Pune",
  slug: "pulse-fitness-pune",
  legalName: "Pulse Fitness Private Limited",
  stateCode: "27",
  planCode: "starter",
  branches: [{ code: "MAIN", name: "Koregaon Park", city: "Pune" }],
  owner: { email: "owner@pulsefitness.test", name: "Sneha Kulkarni" },
  people: [
    // Staff at Iron Temple and a member here (D-04: one global identity).
    {
      email: "riya@example.test",
      name: "Riya Kapoor",
      roles: [{ roleKey: "MEMBER", branch: "MAIN" }],
    },
  ],
};

const STAFF_ROLES = new Set([
  "GYM_OWNER",
  "GYM_ADMIN",
  "BRANCH_MANAGER",
  "RECEPTIONIST",
  "SALES_STAFF",
  "TRAINER",
  "ACCOUNTANT",
]);

/** M2: plans, members, invoices and payments (skipped if the gym already has plans). */
async function seedGymMembers(
  db: PrismaClient,
  gym: GymSeed,
  options: { gstin?: string; activeMemberEmail?: string } = {},
) {
  const { gstin, activeMemberEmail } = options;
  const tenant = await db.tenant.findUniqueOrThrow({
    where: { slug: gym.slug },
  });
  const owner = await db.user.findUniqueOrThrow({
    where: { email: gym.owner.email },
  });
  const ctx = await authContextFor(db, owner.id, tenant.id);
  if (!ctx)
    throw new Error(`${gym.owner.email} is not an owner of ${gym.name}`);
  const deps = { db, entitlements: noEntitlementCache };
  const { branchId, hasPlans } = await withTenant(
    db,
    tenant.id,
    async (tx) => ({
      branchId: (await tx.branch.findFirstOrThrow({ where: { code: "MAIN" } }))
        .id,
      hasPlans: (await tx.membershipPlan.count()) > 0,
    }),
  );
  if (hasPlans) {
    console.log(`- ${gym.name}: members and plans already there, skipped`);
    return;
  }
  if (gstin) {
    // A GST-registered demo gym, so tax invoices show the CGST/SGST split.
    await withTenant(db, tenant.id, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId: tenant.id },
        data: {
          gstRegistered: true,
          gstin,
          pricesIncludeTax: true,
          invoicePrefix: "IT",
        },
      }),
    );
  }
  const accounts = new Map(
    (
      await db.user.findMany({
        where: {
          email: {
            in: gym.people
              .filter((p) => p.roles.some((r) => r.roleKey === "MEMBER"))
              .map((p) => p.email),
          },
        },
      })
    ).map((u) => [u.email, u.id]),
  );
  await seedDemoMembers(deps, ctx, { branchId, accounts, activeMemberEmail });
  // Accounts with a MEMBER role but no demo profile (e.g. the cross-gym user) get a paid membership.
  const linked = await withTenant(db, tenant.id, (tx) =>
    tx.memberProfile.findMany({
      where: { userId: { not: null } },
      select: { userId: true },
    }),
  );
  const plan = await withTenant(db, tenant.id, (tx) =>
    tx.membershipPlan.findFirstOrThrow({
      where: { name: "Monthly Unlimited" },
    }),
  );
  let phone = 9876500100;
  for (const [email, userId] of accounts) {
    if (linked.some((l) => l.userId === userId)) continue;
    const person = gym.people.find((p) => p.email === email)!;
    const [firstName, ...rest] = person.name.split(" ");
    const m = await createMember(deps, ctx, {
      firstName: firstName!,
      lastName: rest.join(" "),
      email,
      phone: String(phone++),
      homeBranchId: branchId,
    });
    await withTenant(db, tenant.id, (tx) =>
      tx.memberProfile.update({ where: { id: m.id }, data: { userId } }),
    );
    await sellMembership(deps, ctx, {
      memberId: m.id,
      planId: plan.id,
      payment: { method: "CASH", amountMinor: 200_000 },
    });
  }
  console.log(`- ${gym.name}: plans, members, invoices and payments added`);
}

async function seedGym(db: PrismaClient, gym: GymSeed) {
  const existing = await db.tenant.findUnique({ where: { slug: gym.slug } });
  if (existing) {
    console.log(`- ${gym.name}: already there, skipped`);
    return;
  }
  const owner = await upsertPasswordUser(db, { ...gym.owner, password });
  const [first, ...rest] = gym.branches;
  const { tenantId } = await createTenantForOwner(
    { db, entitlements: noEntitlementCache },
    { userId: owner.id },
    {
      gymName: gym.name,
      legalName: gym.legalName,
      stateCode: gym.stateCode,
      branchName: first?.name,
      branchCity: first?.city,
    },
  );
  const plan = await db.saasPlan.findFirstOrThrow({
    where: { code: gym.planCode, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });
  await db.tenantSubscription.update({
    where: { tenantId },
    data: { planId: plan.id },
  });

  const userIds = new Map<string, string>();
  for (const person of gym.people) {
    userIds.set(
      person.email,
      (await upsertPasswordUser(db, { ...person, password })).id,
    );
  }

  await withTenant(db, tenantId, async (tx) => {
    const branchIds = new Map<string, string>();
    for (const b of await tx.branch.findMany()) branchIds.set(b.code, b.id);
    for (const b of rest) {
      const created = await tx.branch.create({
        data: {
          tenantId,
          code: b.code,
          name: b.name,
          city: b.city,
          stateCode: gym.stateCode,
        },
      });
      branchIds.set(b.code, created.id);
      await bumpUsage(tx, tenantId, "branches.max", 1);
    }
    for (const person of gym.people) {
      const membership = await tx.tenantMembership.create({
        data: { tenantId, userId: userIds.get(person.email)! },
      });
      for (const role of person.roles) {
        await tx.roleAssignment.create({
          data: {
            tenantId,
            membershipId: membership.id,
            roleKey: role.roleKey,
            branchId: role.branch ? branchIds.get(role.branch)! : null,
          },
        });
      }
      if (person.roles.some((r) => STAFF_ROLES.has(r.roleKey))) {
        await bumpUsage(tx, tenantId, "staff.max", 1);
      }
    }
  });
  console.log(
    `- ${gym.name}: created (${gym.branches.length} branch${gym.branches.length === 1 ? "" : "es"}, ${gym.people.length + 1} users)`,
  );
}

/** M3: classes, a trainer, PT (skipped if the gym already has classes). */
async function seedGymFloor(
  db: PrismaClient,
  gym: GymSeed,
  options: { trainerEmail: string; memberEmail: string },
) {
  const tenant = await db.tenant.findUniqueOrThrow({
    where: { slug: gym.slug },
  });
  const owner = await db.user.findUniqueOrThrow({
    where: { email: gym.owner.email },
  });
  const ctx = await authContextFor(db, owner.id, tenant.id);
  if (!ctx)
    throw new Error(`${gym.owner.email} is not an owner of ${gym.name}`);
  const trainer = await db.user.findUnique({
    where: { email: options.trainerEmail },
  });
  const branchId = await withTenant(
    db,
    tenant.id,
    async (tx) =>
      (await tx.branch.findFirstOrThrow({ where: { code: "MAIN" } })).id,
  );
  const added = await seedFloorDemo(
    { db, entitlements: noEntitlementCache },
    ctx,
    { branchId, trainerUserId: trainer?.id, memberEmail: options.memberEmail },
  );
  console.log(
    added
      ? `- ${gym.name}: classes, trainer and PT package added`
      : `- ${gym.name}: classes already there, skipped`,
  );
}

const db = createPrismaClient(ownerUrl);
const platformDb = createPrismaClient(platformUrl);
try {
  console.log("Seeding demo data…");
  await seedGym(db, IRON);
  await seedGym(db, PULSE);
  await seedGymMembers(db, IRON, {
    gstin: `08AAKFI1234M1Z${gstinCheckChar("08AAKFI1234M1Z")}`,
    activeMemberEmail: "member@irontemple.test",
  });
  await seedGymMembers(db, PULSE);
  await seedGymFloor(db, IRON, {
    trainerEmail: "trainer@irontemple.test",
    memberEmail: "member@irontemple.test",
  });

  {
    // M5: CRM demo (campaign, website form, leads at different stages).
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: IRON.slug },
    });
    const owner = await db.user.findUniqueOrThrow({
      where: { email: IRON.owner.email },
    });
    const ctx = await authContextFor(db, owner.id, tenant.id);
    if (!ctx)
      throw new Error(`${IRON.owner.email} is not an owner of ${IRON.name}`);
    console.log(
      (await seedCrmDemo(db, ctx, tenant.slug))
        ? `- ${IRON.name}: CRM demo added (5 leads, a campaign, a website form at /l/${tenant.slug}/…)`
        : `- ${IRON.name}: leads already there, skipped`,
    );
  }

  const fakePayments = process.env.PAYMENTS_FAKE_ENABLED === "true";
  if (fakePayments) {
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: IRON.slug },
    });
    const owner = await db.user.findUniqueOrThrow({
      where: { email: IRON.owner.email },
    });
    const ctx = await authContextFor(db, owner.id, tenant.id);
    if (!ctx)
      throw new Error(`${IRON.owner.email} is not an owner of ${IRON.name}`);
    const added = await seedGymPayments(db, ctx, "Monthly Unlimited");
    console.log(
      `- ${IRON.name}: online payments with the TEST provider ${added ? "connected" : "already connected"}; Monthly Unlimited can be bought in the app`,
    );
  } else {
    console.log(
      "- Online payments: skipped (set PAYMENTS_FAKE_ENABLED=true for the test provider)",
    );
  }

  if (process.env.WHATSAPP_FAKE_ENABLED === "true") {
    // M6: WhatsApp (test provider), an audience, a draft campaign, workflows, retention flags.
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: IRON.slug },
    });
    const owner = await db.user.findUniqueOrThrow({
      where: { email: IRON.owner.email },
    });
    const ctx = await authContextFor(db, owner.id, tenant.id);
    if (!ctx)
      throw new Error(`${IRON.owner.email} is not an owner of ${IRON.name}`);
    console.log(
      (await seedGrowthDemo(db, ctx))
        ? `- ${IRON.name}: WhatsApp TEST provider connected, audience + draft campaign, 5 workflows (expiry reminders on), retention flags computed`
        : `- ${IRON.name}: WhatsApp already connected, skipped`,
    );
  } else {
    console.log(
      "- WhatsApp: skipped (set WHATSAPP_FAKE_ENABLED=true for the test provider)",
    );
  }

  {
    // M7: fitness, nutrition and engagement for Iron Temple's trainer and demo member.
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: IRON.slug },
    });
    const owner = await db.user.findUniqueOrThrow({
      where: { email: IRON.owner.email },
    });
    const ctx = await authContextFor(db, owner.id, tenant.id);
    if (!ctx)
      throw new Error(`${IRON.owner.email} is not an owner of ${IRON.name}`);
    console.log(
      (await seedFitnessDemo(db, platformDb, ctx, {
        trainerEmail: "trainer@irontemple.test",
        memberEmail: "member@irontemple.test",
      }))
        ? `- ${IRON.name}: fitness demo added (template, plan + logged workout for member@irontemple.test, diet plan, challenge, perk, announcement; nutrition switched on for the demo)`
        : `- ${IRON.name}: workout templates already there, skipped`,
    );
    const intel = await seedIntelligenceDemo(db, platformDb, tenant.id);
    console.log(
      `- ${IRON.name}: AI Copilot ${intel.overridesAdded ? "switched on for the demo" : "already on"}; KPI rollup rebuilt for ${intel.rollupDays} days`,
    );
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const admin = await upsertPlatformUser(platformDb, {
      email: adminEmail,
      name: process.env.SEED_ADMIN_NAME || "Platform Admin",
      password: adminPassword,
      role: "SUPER_ADMIN",
    });
    console.log(`- Super Admin ${adminEmail}: ready`);
    if (fakePayments && (await seedPlatformPayments(platformDb, admin.id)))
      console.log(
        "- Platform billing: TEST provider account set (owners can try subscribing)",
      );
  } else {
    console.log(
      "- Super Admin: skipped (set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or run pnpm platform:create-admin)",
    );
  }

  console.log("\nGym users (staff sign in at APP_URL):");
  for (const email of [
    IRON.owner.email,
    ...IRON.people.map((p) => p.email),
    PULSE.owner.email,
  ]) {
    console.log(`  ${email}`);
  }
  console.log(
    generated
      ? `\nGenerated password for every gym user: ${password}\n(set SEED_DEMO_PASSWORD to choose your own; it only applies to users created or updated now)`
      : "\nPassword for every gym user: the value of SEED_DEMO_PASSWORD",
  );
} finally {
  await db.$disconnect();
  await platformDb.$disconnect();
}
