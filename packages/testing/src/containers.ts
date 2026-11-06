/**
 * Vitest global setup for integration tests on Testcontainers (D-02): starts a private
 * PostgreSQL 18 (with the same gym_app / gym_platform roles as docker-compose) and Redis 8, and
 * points the test env at them. Enabled with TESTCONTAINERS=1; otherwise tests use the Compose
 * services from .env. Either way each test file still gets its own throwaway database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";

const ROLES_SQL = fileURLToPath(
  new URL("../../../infra/postgres/01-roles.sql", import.meta.url),
);

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

function urlFor(
  container: StartedPostgreSqlContainer,
  user: string,
  password: string,
) {
  return `postgresql://${user}:${password}@${container.getHost()}:${container.getPort()}/gym`;
}

export default async function setup() {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:18-alpine")
      .withDatabase("gym")
      .withUsername("gym_owner")
      .withPassword("gym_owner_dev_pw")
      .withCopyFilesToContainer([
        {
          source: path.resolve(ROLES_SQL),
          target: "/docker-entrypoint-initdb.d/01-roles.sql",
        },
      ])
      .start(),
    new RedisContainer("redis:8-alpine").start(),
  ]);

  // Workers are started after global setup, so they inherit these.
  process.env.MIGRATION_DATABASE_URL = urlFor(
    postgres,
    "gym_owner",
    "gym_owner_dev_pw",
  );
  process.env.DATABASE_URL = urlFor(postgres, "gym_app", "gym_app_dev_pw");
  process.env.PLATFORM_DATABASE_URL = urlFor(
    postgres,
    "gym_platform",
    "gym_platform_dev_pw",
  );
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getPort()}`;

  return async () => {
    await Promise.all([postgres?.stop(), redis?.stop()]);
  };
}

/** For vitest configs: the global setup to use, or none when Testcontainers is off. */
export function containersGlobalSetup(): string[] {
  return process.env.TESTCONTAINERS === "1"
    ? [fileURLToPath(import.meta.url)]
    : [];
}
