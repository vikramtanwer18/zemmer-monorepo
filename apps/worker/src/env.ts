import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadEnv, workerEnvSchema, type WorkerEnv } from "@gym/env";

// Root .env, three folders up from src/ (and from dist/ after bundling). Missing in Docker: that's fine.
loadDotenv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});

let cached: WorkerEnv | undefined;

export function getEnv(): WorkerEnv {
  cached ??= loadEnv(workerEnvSchema);
  return cached;
}
