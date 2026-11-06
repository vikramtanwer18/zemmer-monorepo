import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../db/prisma/migrations", import.meta.url),
);

export type TestDatabase = {
  name: string;
  /** gym_owner: create probe tables, seed data. */
  ownerUrl: string;
  /** gym_app: what web + worker use at runtime. RLS applies. */
  appUrl: string;
  /** gym_platform: what admin uses at runtime. */
  platformUrl: string;
  /** Drops the database. Call it in afterAll. */
  drop: () => Promise<void>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Integration tests load the root .env; did you copy .env.example?`,
    );
  }
  return value;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a uniquely named, fully migrated database (e.g. gym_test_1a2b3c4d) so each test file
 * starts empty and development data is never touched.
 */
export async function createTestDatabase(
  options: { migrationsDir?: string } = {},
): Promise<TestDatabase> {
  const ownerBase = requireEnv("MIGRATION_DATABASE_URL");
  const appBase = requireEnv("DATABASE_URL");
  const platformBase = requireEnv("PLATFORM_DATABASE_URL");

  const name = `gym_test_${randomBytes(4).toString("hex")}`;

  await withClient(ownerBase, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
    await client.query(
      `GRANT CONNECT ON DATABASE "${name}" TO gym_app, gym_platform`,
    );
  });

  const ownerUrl = withDatabase(ownerBase, name);
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  await withClient(ownerUrl, async (client) => {
    for (const migration of migrations) {
      const sql = await readFile(
        path.join(migrationsDir, migration, "migration.sql"),
        "utf8",
      );
      await client.query(sql);
    }
  });

  return {
    name,
    ownerUrl,
    appUrl: withDatabase(appBase, name),
    platformUrl: withDatabase(platformBase, name),
    drop: () =>
      withClient(ownerBase, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }),
  };
}
