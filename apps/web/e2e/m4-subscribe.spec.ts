import { expect, test } from "@playwright/test";
import {
  createPaymentsGym,
  ensureFakePlatformAccount,
  passOtp,
  signIn,
} from "./fixtures";

// Cross-app check (gym app → admin app → worker): an owner picks a plan, pays on the test
// subscription checkout, and the verified webhook (processed by the worker) makes it ACTIVE.
// Needs the admin app and the worker running, so it only runs when E2E_ADMIN_URL is set and this
// app's ADMIN_URL points at that admin app.
const adminUrl = process.env.E2E_ADMIN_URL;

test.skip(!adminUrl, "set E2E_ADMIN_URL (admin app + worker running) to run");

test("owner subscribes: plan → test checkout → webhook → active, with a SaaS bill", async ({
  page,
}) => {
  test.setTimeout(150_000);
  test.skip(
    !(await ensureFakePlatformAccount()),
    "a real platform payment account is set",
  );
  const { owner } = await createPaymentsGym();
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();

  await page.goto("/settings/plan");
  await page.getByRole("button", { name: "Choose Growth" }).click();
  // The admin app's test checkout (Razorpay's subscription page in production).
  await expect(page).toHaveURL(new RegExp(`^${adminUrl}/dev/fake-subscribe/`));
  await page.getByRole("button", { name: "Pay and subscribe" }).click();
  await expect(page).toHaveURL(/\/settings\/plan\?notice=/);

  // The worker applies the webhook within seconds.
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("button", { name: /Switch to/ }).first(),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /^SAAS\// })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("subscribed.png"),
    fullPage: true,
  });
});
