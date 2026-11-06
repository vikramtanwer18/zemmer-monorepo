import "server-only";
import { loadEnv, webEnvSchema, type WebEnv } from "@gym/env";

let cached: WebEnv | undefined;

/** Validated server environment. Validates on first call, then caches. */
export function getEnv(): WebEnv {
  cached ??= loadEnv(webEnvSchema);
  return cached;
}
