import {
  firstLink,
  testEmail,
  testPassword,
  waitForEmail,
} from "@gym/testing/e2e";
import { expect, test } from "@playwright/test";
import { createOwnerWithGym, onServer, passOtp, signIn } from "./fixtures";

test.skip(({ isMobile }) => isMobile, "flows run on desktop only");

// The M2 main path: plan → member → sell → part payment → member app shows the dues →
// rest paid by UPI → membership active → invoice PDF downloads (for staff and the member).
test("sell a membership, take payments, and the member sees it in the app", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await createOwnerWithGym();
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(
    page.getByRole("heading", { name: `Welcome, ${owner.name}` }),
  ).toBeVisible();

  // Plan (the new gym isn't GST-registered, so it issues a Bill of ₹1,000).
  await page.goto("/plans/new");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("E2E Monthly");
  await page.getByLabel("Price (₹)").fill("1000");
  await page.getByLabel("Joining fee (₹)").fill("");
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("link", { name: "E2E Monthly" })).toBeVisible();

  // Member.
  const memberEmail = testEmail("member");
  await page.goto("/members/new");
  await page.getByLabel("First name").fill("Meera");
  await page.getByLabel("Last name").fill("Member");
  await page
    .getByRole("textbox", { name: "Mobile", exact: true })
    .fill(`98${String(Date.now()).slice(-8)}`);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(memberEmail);
  await page.getByLabel("Home branch").selectOption({ label: "E2E Main" });
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(
    page.getByRole("heading", { name: "Meera Member" }),
  ).toBeVisible();
  const memberUrl = new URL(page.url()).pathname;

  // Sell with ₹400 cash now.
  await page.goto(`${memberUrl}/sell`);
  await page.locator('select[name="planId"]').selectOption({ index: 1 });
  await page.getByRole("button", { name: "Preview invoice" }).click();
  await expect(
    page.getByRole("heading", { name: "2. Check and confirm" }),
  ).toBeVisible();
  await page.getByLabel("Record a payment now").check();
  await page.getByLabel("Amount (₹)").fill("400");
  await page.getByRole("button", { name: "Issue invoice and sell" }).click();
  await expect(page.getByText(/Sold\. Invoice .+ issued\./)).toBeVisible();
  await expect(page.getByText("Awaiting payment").first()).toBeVisible();

  // Invite the member to the app.
  await page.goto(memberUrl);
  const invitedAfter = new Date(Date.now() - 1000);
  await page.getByRole("button", { name: "Send app invite" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("App invite sent.")).toBeVisible();

  // The member, in their own browser session: account → verify email → accept → member app.
  const memberContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const member = await memberContext.newPage();
  const invite = await waitForEmail(memberEmail, {
    subject: /member app/,
    after: invitedAfter,
  });
  await member.goto(onServer(firstLink(invite.text)));
  await member.getByRole("link", { name: "Create my account" }).click();
  await member.getByLabel("Your name").fill("Meera Member");
  await member.getByLabel("Password").fill(testPassword());
  await member.getByRole("button", { name: "Create account" }).click();
  const verify = await waitForEmail(memberEmail, {
    subject: /Verify your email/,
  });
  await member.goto(onServer(firstLink(verify.text)));
  await member.getByRole("button", { name: "Accept invitation" }).click();

  // M4 onboarding: the privacy notice comes first.
  await expect(member).toHaveURL(/\/m\/privacy\?next=/);
  await member.getByRole("button", { name: "I understand, continue" }).click();
  await expect(member).toHaveURL(/\/m\/$/);
  await expect(
    member.getByRole("heading", { name: "Hi, Meera" }),
  ).toBeVisible();
  await expect(member.getByText(/600\.00 due/)).toBeVisible();
  await expect(member.getByText("Waiting for payment")).toBeVisible();
  // A member has no business in the staff app.
  await member.goto("/members");
  await expect(member).toHaveURL(/\/m\/$/);

  // Staff takes the rest by UPI.
  await page.goto(`${memberUrl}/pay`);
  await expect(page.getByLabel("Amount received (₹)")).toHaveValue("600.00");
  await page.getByLabel("Method").selectOption("UPI");
  await page.getByLabel("Reference").fill("UPI-E2E-0001");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(
    page.getByText(/Payment recorded \(receipt .+\)\./),
  ).toBeVisible();

  // The member now sees an active membership and a paid invoice.
  await member.reload();
  await expect(member.getByText("Active", { exact: true })).toBeVisible();
  await expect(member.getByText(/days? left/)).toBeVisible();
  await expect(member.getByText(/due$/)).toHaveCount(0);
  await member
    .getByRole("navigation", { name: "Member app" })
    .getByRole("link", { name: "Payments" })
    .click();
  await expect(member.getByText("paid", { exact: true })).toBeVisible();
  await member
    .getByRole("link", { name: /\/\d{2}-\d{2}\/\d{5}/ })
    .first()
    .click();
  const pdfHref = await member
    .getByRole("link", { name: "Download PDF" })
    .getAttribute("href");
  const memberPdf = await member.request.get(pdfHref!);
  expect(memberPdf.status()).toBe(200);
  expect(memberPdf.headers()["content-type"]).toContain("application/pdf");
  expect((await memberPdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Staff can download the same PDF; a signed-out visitor can't.
  expect((await page.request.get(pdfHref!)).status()).toBe(200);
  const anonymous = await browser.newContext();
  expect(
    (
      await anonymous.request.get(new URL(pdfHref!, page.url()).toString())
    ).status(),
  ).toBe(401);
  await anonymous.close();
  await memberContext.close();

  // Dashboard (M8 KPI cards): one active member, ₹1,000 collected, nothing outstanding.
  await page.goto("/");
  await expect(
    page.locator('[data-kpi="members.active"] [data-kpi-value]'),
  ).toHaveText("1");
  await expect(
    page.locator('[data-kpi="revenue.collected"] [data-kpi-value]'),
  ).toHaveText("₹1,000.00");
  await expect(
    page.locator('[data-kpi="dues.outstanding"] [data-kpi-value]'),
  ).toHaveText("₹0.00");
});
