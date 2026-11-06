import {
  firstLink,
  testEmail,
  testPassword,
  waitForEmail,
} from "@gym/testing/e2e";
import { expect, test } from "@playwright/test";
import {
  createOwnerWithGym,
  createPlatformAdmin,
  onServer,
  passOtp,
  signIn,
} from "./fixtures";

// Full flows run once, on desktop; layout at phone width is covered by the mobile project's smoke tests.
test.skip(({ isMobile }) => isMobile, "flows run on desktop only");

test("owner signup → verify email → set up gym → OTP → trial dashboard", async ({
  page,
}) => {
  const email = testEmail("signup");
  const password = testPassword();

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Asha Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();

  const verification = await waitForEmail(email, {
    subject: /Verify your email/,
  });
  await page.goto(onServer(firstLink(verification.text)));

  await expect(
    page.getByRole("heading", { name: "Set up your gym" }),
  ).toBeVisible();
  await page.getByLabel("Gym name").fill(`Asha Fitness ${Date.now()}`);
  await page.getByLabel("State").selectOption({ label: "Rajasthan" });
  await page.getByLabel("Branch name").fill("Vaishali Nagar");
  await page.getByRole("button", { name: "Start my free trial" }).click();

  // Owners always need the email code (D-03), even right after signing up.
  await passOtp(page, email);
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha Owner" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Free trial of the Starter plan: 1[34] days left/),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Staff" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("owner invites a receptionist, who accepts and sees only permitted navigation", async ({
  page,
  browser,
}) => {
  const owner = await createOwnerWithGym();
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(
    page.getByRole("heading", { name: `Welcome, ${owner.name}` }),
  ).toBeVisible();

  const invitee = testEmail("reception");
  await page.goto("/staff");
  await page.getByLabel("Email").fill(invitee);
  await page.getByLabel("Role").selectOption({ value: "RECEPTIONIST" });
  await page
    .getByRole("combobox", { name: "Branch", exact: true })
    .selectOption({ label: "E2E Main" });
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation sent.")).toBeVisible();
  await expect(page.getByRole("cell", { name: invitee })).toBeVisible();

  // The receptionist, in a separate browser session.
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const guest = await context.newPage();
  const invitation = await waitForEmail(invitee, { subject: /^Join / });
  await guest.goto(onServer(firstLink(invitation.text)));
  await expect(
    guest.getByRole("heading", { name: /^Join E2E Gym/ }),
  ).toBeVisible();
  await guest.getByRole("link", { name: "Create my account" }).click();
  await guest.getByLabel("Your name").fill("Ravi Reception");
  await expect(guest.getByLabel("Email")).toHaveValue(invitee);
  await guest.getByLabel("Password").fill(testPassword());
  await guest.getByRole("button", { name: "Create account" }).click();
  const verify = await waitForEmail(invitee, { subject: /Verify your email/ });
  await guest.goto(onServer(firstLink(verify.text)));
  await guest.getByRole("button", { name: "Accept invitation" }).click();

  await expect(
    guest.getByRole("heading", { name: "Welcome, Ravi Reception" }),
  ).toBeVisible();
  const nav = guest.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Branches" })).toBeVisible();
  for (const hidden of ["Staff", "Settings", "Audit log"]) {
    await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
  }
  // Typing the URL doesn't help either: the page itself checks the permission.
  await guest.goto("/settings/tax");
  await expect(
    guest.getByText("You don't have access to this page"),
  ).toBeVisible();
  await context.close();

  // The owner now sees them on the team.
  await page.goto("/staff");
  await expect(
    page
      .getByRole("table", { name: "Team" })
      .getByText("Ravi Reception", { exact: true }),
  ).toBeVisible();
});

test("a platform admin cannot sign in to the gym app", async ({ page }) => {
  const admin = await createPlatformAdmin();
  await signIn(page, admin.email, admin.password);
  await expect(
    page.getByText("That email and password don't match."),
  ).toBeVisible();
});

test("the Google button is hidden when Google isn't configured", async ({
  page,
}) => {
  test.skip(
    Boolean(process.env.GOOGLE_CLIENT_ID),
    "Google is configured in this environment",
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
});

test("signed-out visitors are sent to sign in, keeping where they were going", async ({
  page,
}) => {
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fstaff$/);
});
