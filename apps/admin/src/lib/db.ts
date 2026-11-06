import "server-only";
import { getPrismaClient, type PrismaClient } from "@gym/db";
import { getEnv } from "@/env";

/** The runtime database client (role from PLATFORM_DATABASE_URL). Created lazily so `next build` needs no secrets. */
export function getDb(): PrismaClient {
  return getPrismaClient(getEnv().PLATFORM_DATABASE_URL);
}
