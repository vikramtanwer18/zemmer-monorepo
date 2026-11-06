import { expect, test, type Page } from "@playwright/test";
import { createIntelligenceGym, passOtp, signIn } from "./fixtures";

// M8: dashboard + reports on the KPI registry, and the Copilot (fake provider) answering
// "Which memberships expire this week?" with the same members the records list shows.

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

async function ownerSignIn(
  page: Page,
  owner: { email: string; password: string },
) {
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
}

test("owner asks the Copilot which memberships expire this week → the list matches the records", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const gym = await createIntelligenceGym();
  await ownerSignIn(page, gym.owner);

  await page.goto("/copilot");
  await expect(page.getByRole("heading", { name: "Copilot" })).toBeVisible();
  await page
    .getByRole("button", { name: "Which memberships expire this week?" })
    .click();
  const answer = page.locator("[data-copilot-answer]").first();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer).toContainText("2 memberships end in the next 7 days");
  for (const name of gym.expiring) await expect(answer).toContainText(name);
  await expect(answer).not.toContainText(gym.later);
  await expect(
    answer.getByRole("link", { name: "Members expiring soon" }),
  ).toBeVisible();
  await answer.getByText("Show the data").click();
  await expect(answer.getByText("list expiring memberships")).toBeVisible();
  await noHorizontalScroll(page);

  // The same people on the records list the source links to.
  await answer.getByRole("link", { name: "Members expiring soon" }).click();
  await expect(page).toHaveURL(/\/members\?expiringDays=7/);
  for (const name of gym.expiring)
    await expect(
      page.getByRole("link", { name: new RegExp(name) }).first(),
    ).toBeVisible();
  await expect(page.getByText(gym.later)).toHaveCount(0);
});

test("dashboard and reports agree; drill down to records; export is queued", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const gym = await createIntelligenceGym();
  await ownerSignIn(page, gym.owner);

  const expiringCard = page.locator('[data-kpi="memberships.expiring"]');
  await expect(expiringCard.locator("[data-kpi-value]")).toHaveText("2");
  await expect(
    page.locator('[data-kpi="members.active"] [data-kpi-value]'),
  ).toHaveText("3");
  await expect(page.getByText(/KPI definitions v0\.2/)).toBeVisible();
  await noHorizontalScroll(page);

  await page.goto("/reports");
  await page.getByRole("link", { name: /^Membership/ }).click();
  await expect(
    page.getByRole("heading", { name: "Membership", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-kpi="memberships.expiring"] [data-kpi-value]'),
  ).toHaveText("2");
  await expect(
    page.locator('[data-kpi="members.new"] [data-kpi-value]'),
  ).toHaveText("3");
  for (const name of [...gym.expiring, gym.later])
    await expect(
      page.getByRole("link", { name: new RegExp(name) }),
    ).toBeVisible();
  await noHorizontalScroll(page);

  // The definition is one click away; the card links to the filtered list.
  await page
    .locator('[data-kpi="memberships.expiring"]')
    .getByText("Definition")
    .click();
  await expect(page.getByText(/no renewal already bought/)).toBeVisible();

  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText(/Export started/)).toBeVisible();
  await expect(page.locator("[data-export-status]").first()).toBeVisible();
});
