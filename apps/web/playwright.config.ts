import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config as loadDotenv } from "dotenv";

// Fixtures write to the development database and read Mailpit; both come from the root .env.
loadDotenv({
  path: path.resolve(import.meta.dirname, "../../.env"),
  quiet: true,
});

// E2E_BASE_URL points the tests at another running server (e.g. a build on a spare port).
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // Runs the built app; `turbo run test:e2e` builds first.
    command: "pnpm start",
    // Turns on the /ui design-system showcase for the accessibility check.
    env: { UI_SHOWCASE: "1" },
    url: `${baseURL}/api/health`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
