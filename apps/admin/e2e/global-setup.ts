import { clearRateLimits } from "@gym/testing/e2e";

export default async function globalSetup() {
  await clearRateLimits();
}
