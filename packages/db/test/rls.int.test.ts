import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@gym/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  InvalidTenantIdError,
  withTenant,
  type PrismaClient,
} from "../src";

// Proves the isolation design with a probe table that copies the policy every gym-owned table will use.

const GYM_A = randomUUID();
const GYM_B = randomUUID();

type ProbeRow = { tenant_id: string; note: string };

let db: TestDatabase;
let app: PrismaClient;

beforeAll(async () => {
  db = await createTestDatabase();

  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  await owner.query(`
    CREATE TABLE app.rls_probe (
      id serial PRIMARY KEY,
      tenant_id uuid NOT NULL,
      note text NOT NULL
    );
    ALTER TABLE app.rls_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app.rls_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON app.rls_probe
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
  await owner.end();

  // One connection, so "does not leak to the next query" really reuses the same connection.
  app = createPrismaClient(db.appUrl, { maxConnections: 1 });
});

afterAll(async () => {
  await app?.$disconnect();
  await db?.drop();
});

describe("row-level security", () => {
  it("gym A can insert and read its own row", async () => {
    const rows = await withTenant(app, GYM_A, async (tx) => {
      await tx.$executeRaw`INSERT INTO app.rls_probe (tenant_id, note) VALUES (${GYM_A}::uuid, 'a-row')`;
      return tx.$queryRaw<
        ProbeRow[]
      >`SELECT tenant_id::text, note FROM app.rls_probe`;
    });
    expect(rows).toEqual([{ tenant_id: GYM_A, note: "a-row" }]);
  });

  it("gym B sees zero rows, with no WHERE clause", async () => {
    const rows = await withTenant(
      app,
      GYM_B,
      (tx) =>
        tx.$queryRaw<
          ProbeRow[]
        >`SELECT tenant_id::text, note FROM app.rls_probe`,
    );
    expect(rows).toHaveLength(0);
  });

  it("returns nothing when no tenant is set", async () => {
    const rows = await app.$queryRaw<
      ProbeRow[]
    >`SELECT tenant_id::text, note FROM app.rls_probe`;
    expect(rows).toHaveLength(0);
  });

  it("gym A cannot insert a row tagged as gym B", async () => {
    await expect(
      withTenant(
        app,
        GYM_A,
        (tx) =>
          tx.$executeRaw`INSERT INTO app.rls_probe (tenant_id, note) VALUES (${GYM_B}::uuid, 'sneaky')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the tenant id does not leak into the next query on the same connection", async () => {
    const inside = await withTenant(
      app,
      GYM_A,
      (tx) =>
        tx.$queryRaw<
          { tenant: string | null }[]
        >`SELECT app.current_tenant_id()::text AS tenant`,
    );
    expect(inside[0]?.tenant).toBe(GYM_A);

    const after = await app.$queryRaw<
      { tenant: string | null }[]
    >`SELECT app.current_tenant_id()::text AS tenant`;
    expect(after[0]?.tenant).toBeNull();
    const rows = await app.$queryRaw<
      ProbeRow[]
    >`SELECT tenant_id::text, note FROM app.rls_probe`;
    expect(rows).toHaveLength(0);
  });

  it("gym_platform gets permission denied on the probe table", async () => {
    const platform = new pg.Client({ connectionString: db.platformUrl });
    await platform.connect();
    try {
      await expect(
        platform.query("SELECT * FROM app.rls_probe"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await platform.end();
    }
  });

  it("rejects a non-UUID tenant id before any SQL runs", async () => {
    let ran = false;
    await expect(
      withTenant(app, "1 OR 1=1", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(ran).toBe(false);
  });
});
