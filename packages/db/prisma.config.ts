import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

// The monorepo keeps one .env at the root.
loadDotenv({
  path: path.resolve(import.meta.dirname, "../../.env"),
  quiet: true,
});

// Migrations run as the owner role. `prisma generate` doesn't need a URL, so only set it when
// present: Docker builds and CI type checks run without it.
const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx src/seed.ts",
  },
  ...(url ? { datasource: { url } } : {}),
});
