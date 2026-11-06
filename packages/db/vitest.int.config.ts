import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { containersGlobalSetup } from "@gym/testing/containers";
import { defineConfig } from "vitest/config";

loadDotenv({
  path: path.resolve(import.meta.dirname, "../../.env"),
  quiet: true,
});

export default defineConfig({
  test: {
    // TESTCONTAINERS=1 runs against private Postgres/Redis containers instead of .env services.
    globalSetup: containersGlobalSetup(),
    include: ["test/**/*.int.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
