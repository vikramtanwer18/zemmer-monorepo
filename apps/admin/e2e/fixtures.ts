import { randomUUID } from "node:crypto";
import { upsertPlatformUser } from "@gym/auth/platform";
import { upsertPasswordUser } from "@gym/auth/tenant";
import { createPrismaClient, type PrismaClient } from "@gym/db";
import {
  otpCode,
  testEmail,
  testPassword,
  waitForEmail,
} from "@gym/testing/e2e";
import { expect, type Page } from "@playwright/test";

let platformDb: PrismaClient | undefined;
let appDb: PrismaClient | undefined;

function platform() {
  platformDb ??= createPrismaClient(process.env.PLATFORM_DATABASE_URL!, {
    maxConnections: 2,
  });
  return platformDb;
}
function app() {
  appDb ??= createPrismaClient(process.env.DATABASE_URL!, {
    maxConnections: 2,
  });
  return appDb;
}

export async function createPlatformAdmin() {
  const email = testEmail("ops");
  const password = testPassword();
  await upsertPlatformUser(platform(), {
    email,
    name: "E2E Ops",
    password,
    role: "SUPER_ADMIN",
  });
  return { email, password };
}

export async function createTenantUser() {
  const email = testEmail("staff");
  const password = testPassword();
  await upsertPasswordUser(app(), { email, name: "E2E Staff", password });
  return { email, password };
}

/** A self-signup tenant waiting for approval (as created when approval is required). */
export async function createPendingTenant() {
  const displayName = `Pending Gym ${Date.now()}`;
  const plan = await platform().saasPlan.findFirstOrThrow({
    where: { code: "starter", status: "ACTIVE" },
  });
  const tenant = await platform().tenant.create({
    data: {
      slug: `pending-${randomUUID().slice(0, 8)}`,
      displayName,
      legalName: displayName,
      status: "PENDING_APPROVAL",
      subscription: {
        create: { planId: plan.id, status: "TRIALING", trialEndsAt: null },
      },
    },
  });
  return { id: tenant.id, displayName };
}

export async function signInWithOtp(
  page: Page,
  email: string,
  password: string,
) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Check it's you" }),
  ).toBeVisible();
  const sentAfter = new Date(Date.now() - 1000);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(
    page.getByText("We've emailed you a 6-digit code"),
  ).toBeVisible();
  const mail = await waitForEmail(email, {
    subject: /sign-in code/,
    after: sentAfter,
  });
  await page.getByLabel("6-digit code").fill(otpCode(mail.text));
  await page.getByRole("button", { name: "Verify" }).click();
}
