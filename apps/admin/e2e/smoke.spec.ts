import { expect, test } from "@playwright/test";
import {
  createPendingTenant,
  createPlatformAdmin,
  createTenantUser,
  signInWithOtp,
} from "./fixtures";

test("health endpoint returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/tenants");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ftenants$/);
  await expect(
    page.getByRole("heading", { name: "Platform sign in" }),
  ).toBeVisible();
});

test("the password alone is not enough: platform sign-in always asks for the email code", async ({
  page,
}) => {
  const admin = await createPlatformAdmin();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Check it's you" }),
  ).toBeVisible();
  // Skipping the code doesn't work either.
  await page.goto("/tenants");
  await expect(page).toHaveURL(/\/verify$/);
});

test("admin signs in with OTP and approves a pending tenant", async ({
  page,
}) => {
  const admin = await createPlatformAdmin();
  const pending = await createPendingTenant();
  await signInWithOtp(page, admin.email, admin.password);
  await expect(
    page.getByRole("heading", { name: "Platform Admin" }),
  ).toBeVisible();

  await page.goto(
    `/tenants?status=PENDING_APPROVAL&q=${encodeURIComponent(pending.displayName)}`,
  );
  await page.getByRole("link", { name: pending.displayName }).click();
  await expect(
    page.getByRole("heading", { name: pending.displayName }),
  ).toBeVisible();
  await expect(page.getByText("pending approval")).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByText("Tenant approved.")).toBeVisible();
  await expect(page.getByText("active", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "tenant.approved" }),
  ).toBeVisible();
});

test("a gym user cannot sign in to the platform console", async ({ page }) => {
  const user = await createTenantUser();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("That email and password don't match."),
  ).toBeVisible();
});
