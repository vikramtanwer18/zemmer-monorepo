import { expect, test, type Page } from "@playwright/test";
import {
  createPaymentsGym,
  latestLinkUrl,
  memberSignIn,
  onServer,
  passOtp,
  setSubscriptionState,
  signIn,
} from "./fixtures";

// M4 main paths with the TEST payment provider (no real money; the dev checkout page stands in
// for Razorpay and sends signed webhooks). Every screen is also checked for sideways scrolling.

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function staffSignIn(
  page: Page,
  owner: { email: string; password: string },
) {
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
}

test("member pays their balance online: checkout → confirming → paid", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { member } = await createPaymentsGym();
  await memberSignIn(page, member.email, member.password);
  await expect(page.getByRole("link", { name: "Pay now" })).toBeVisible();

  await page.goto("/m/invoices");
  await expect(page.getByLabel("Amount to pay (₹)")).toHaveValue("1500.00");
  await noHorizontalScroll(page);
  await page.getByRole("button", { name: "Pay online" }).click();

  // The test checkout (Razorpay's hosted page in production).
  await expect(page).toHaveURL(/\/dev\/fake-pay\//);
  await page.getByRole("button", { name: /^Pay / }).click();

  // Back in the app: the page only believes the server, which confirms within seconds.
  await expect(page).toHaveURL(/\/m\/pay\/return\?link=/);
  await expect(page.getByText("Payment received")).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({
    path: test.info().outputPath("member-paid.png"),
    fullPage: true,
  });

  await page.goto("/m/invoices");
  await expect(page.getByText("₹0.00").first()).toBeVisible();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
});

test("staff send a part-payment link; a part is paid and re-checked", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { owner, invoiceId } = await createPaymentsGym();
  await staffSignIn(page, owner);

  await page.goto(`/invoices/${invoiceId}`);
  await page.getByLabel("Allow part payments").check();
  await page.getByLabel("Smallest part payment (₹)").fill("500");
  await page.getByLabel("Email the link to the member").uncheck();
  await page.getByRole("button", { name: /Send payment link for/ }).click();
  await expect(page.getByText(/Payment link created/)).toBeVisible();
  await expect(page.getByTestId("payment-links")).toContainText(
    "part payments allowed",
  );

  // The member pays ₹500 of ₹1,500 on the checkout page.
  await page.goto(onServer(await latestLinkUrl(owner.tenantId)));
  await page.getByLabel(/Amount to pay now/).fill("500");
  await page.getByRole("button", { name: /^Pay / }).click();
  // The payer is sent on to the member app's "confirming" page (staff aren't members there).
  await expect(page).toHaveURL(/\/m\//);

  await page.goto("/payments/links");
  await page.getByRole("button", { name: "Re-check" }).first().click();
  await expect(
    page.getByText(/Checked with Razorpay: partially paid/),
  ).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto("/payments/dues");
  await expect(page.getByRole("cell", { name: /Payal/ })).toBeVisible();
  await expect(page.getByText("₹1,000.00").first()).toBeVisible();
  await noHorizontalScroll(page);
});

test("subscription problems show banners, and suspended gyms can still pay", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { owner } = await createPaymentsGym();
  await staffSignIn(page, owner);

  await setSubscriptionState(owner.tenantId, "GRACE");
  await page.goto("/");
  await expect(page.getByText("Subscription payment overdue")).toBeVisible();
  await expect(page.getByRole("link", { name: "Check billing" })).toBeVisible();

  await setSubscriptionState(owner.tenantId, "SUSPENDED");
  await page.goto("/");
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pick a plan and pay" }).click();
  await expect(page.getByText("Your gym is read-only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Choose / }).first(),
  ).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath("plan-suspended.png"),
    fullPage: true,
  });
});

test("M4 staff and member screens render", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { owner, member } = await createPaymentsGym();
  await staffSignIn(page, owner);
  for (const [path, heading] of [
    ["/payments/refunds", /^Payments$/],
    ["/payments/reconciliation", /^Payments$/],
    ["/settings/payments", /^Settings$/],
    ["/settings/plan", /^Settings$/],
    ["/members/privacy", /Privacy requests/],
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading }).first(),
    ).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({
      path: test.info().outputPath(`${path.replaceAll("/", "_")}.png`),
      fullPage: true,
    });
  }

  const memberContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: page.viewportSize(),
  });
  const m = await memberContext.newPage();
  await memberSignIn(m, member.email, member.password);
  for (const [path, heading] of [
    ["/m/plans", /^Plans$/],
    ["/m/privacy", /Privacy and your data/],
  ] as const) {
    await m.goto(path);
    await expect(m.getByRole("heading", { name: heading })).toBeVisible();
    await noHorizontalScroll(m);
  }
  await memberContext.close();
});
