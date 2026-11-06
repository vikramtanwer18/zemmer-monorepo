import { expect, test } from "@playwright/test";
import { createPlatformAdmin, signInWithOtp } from "./fixtures";

// M4 operator console: billing, setup, usage, announcements and system health render; signed
// endpoints refuse anything unsigned or forged.

test("unsigned internal requests and forged platform webhooks are refused", async ({
  request,
}) => {
  const checkout = await request.post("/api/internal/billing/checkout", {
    data: {
      tenantId: "00000000-0000-4000-8000-000000000001",
      userId: "u",
      priceId: "00000000-0000-4000-8000-000000000002",
    },
  });
  expect(checkout.status()).toBe(401);
  const forged = await request.post("/api/internal/billing/cancel", {
    headers: {
      "x-internal-timestamp": String(Date.now()),
      "x-internal-signature": "0".repeat(64),
    },
    data: { tenantId: "00000000-0000-4000-8000-000000000001", userId: "u" },
  });
  expect(forged.status()).toBe(401);
  const webhook = await request.post("/api/webhooks/razorpay-platform", {
    headers: {
      "x-razorpay-signature": "0".repeat(64),
      "x-razorpay-event-id": `evt_forged_${Date.now()}`,
    },
    data: { event: "subscription.charged", payload: {} },
  });
  expect(webhook.status()).toBe(400);
});

test("operator billing screens render; an announcement is posted and taken down", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const admin = await createPlatformAdmin();
  await signInWithOtp(page, admin.email, admin.password);
  // Wait for the post-verification redirect before navigating (it would race page.goto).
  await expect(
    page.getByRole("heading", { name: "Platform Admin" }),
  ).toBeVisible();

  for (const [path, heading] of [
    ["/billing", /^Billing$/],
    ["/billing/setup", /Payment account and prices/],
    ["/usage", /^Usage$/],
    ["/system", /System health/],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`${path.replaceAll("/", "_")}.png`),
      fullPage: true,
    });
  }
  await expect(page.getByRole("heading", { name: "Job queues" })).toBeVisible();

  // Shown only to cancelled gyms, so other tests' gyms never see it.
  const title = `E2E notice ${Date.now()}`;
  await page.goto("/announcements");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Message").fill("Planned maintenance on Sunday night.");
  await page.getByLabel("Show to").selectOption("STATUSES");
  await page.getByLabel("cancelled").check();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Announcement published.")).toBeVisible();
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row.getByText("live")).toBeVisible();
  await row.getByRole("button", { name: "Take down" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Take down" })
    .click();
  await expect(page.getByText("Announcement taken down.")).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(title) }).getByText("ended"),
  ).toBeVisible();
});
