import "server-only";
import { loadEnv, adminEnvSchema, type AdminEnv } from "@gym/env";

let cached: AdminEnv | undefined;

/** Validated server environment. Validates on first call, then caches. */
export function getEnv(): AdminEnv {
  cached ??= loadEnv(adminEnvSchema);
  return cached;
}
