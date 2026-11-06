import "server-only";
import { createRedisConnection } from "@gym/core/jobs";
import type { Redis } from "ioredis";
import { getEnv } from "@/env";

const globalForRedis = globalThis as typeof globalThis & { __gymRedis?: Redis };

/** One Redis connection per server process, reused across Next.js dev reloads. */
export function getRedis(): Redis {
  globalForRedis.__gymRedis ??= createRedisConnection(getEnv().REDIS_URL);
  return globalForRedis.__gymRedis;
}
