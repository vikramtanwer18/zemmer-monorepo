import { clearRateLimits } from "@gym/testing/e2e";
import { expect, test, type Page } from "@playwright/test";
import {
  createFitnessGym,
  friendJoinsAndPays,
  memberSignIn,
  signIn,
} from "./fixtures";

// M7: trainer builds a template → assigns → member logs a workout in the PWA → a PR appears →
// trainer leaves feedback → member sees the notification. And: referral → lead → paid → points.

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test("trainer template → assigned plan → member logs a workout → PR → trainer feedback → member notified", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const gym = await createFitnessGym();
  const baseURL = test.info().project.use.baseURL;

  // The member agrees to health-data tracking first (nothing is stored before that).
  const mctx = await browser.newContext({ baseURL });
  const m = await mctx.newPage();
  await memberSignIn(m, gym.member.email, gym.member.password);
  await m.goto("/m/workouts");
  await expect(m.getByTestId("health-consent")).toBeVisible();
  await m.getByRole("checkbox", { name: "I agree" }).check();
  await m.getByRole("button", { name: "Continue" }).click();
  await expect(m.getByText(/You can start tracking now/)).toBeVisible();
  await noHorizontalScroll(m);

  // The trainer builds a template and assigns it.
  const sctx = await browser.newContext({ baseURL });
  const t = await sctx.newPage();
  await clearRateLimits();
  await signIn(t, gym.trainer.email, gym.trainer.password);
  await expect(t.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
  await t.goto("/fitness/templates/edit");
  await expect(t.getByRole("heading", { name: "New template" })).toBeVisible();
  await t.getByLabel(/^Name/).first().fill("E2E strength");
  await t
    .getByLabel("Add exercise to week 1 day 1")
    .selectOption({ label: "Barbell back squat" });
  await t
    .getByLabel("Add exercise to week 1 day 1")
    .selectOption({ label: "Plank" });
  await expect(t.getByTestId("builder-item")).toHaveCount(2);
  await t.getByRole("button", { name: "Save template" }).click();
  await expect(t.getByText("Template saved.")).toBeVisible();
  await noHorizontalScroll(t);
  await t.goto("/fitness");
  await t.getByRole("link", { name: gym.member.name }).first().click();
  await t.getByLabel("Template").selectOption({ label: "E2E strength" });
  await t.getByRole("button", { name: "Assign" }).click();
  await expect(t.getByText(/Plan assigned/)).toBeVisible();
  await expect(t.getByTestId("plan")).toContainText("E2E strength");

  // The member does today's workout, set by set.
  await m.goto("/m/workouts");
  await expect(m.getByTestId("todays-workout")).toContainText(
    "Barbell back squat",
  );
  await m.getByRole("button", { name: "Start workout" }).click();
  await expect(m).toHaveURL(/\/m\/workouts\/log\//);
  await m.getByLabel("Barbell back squat set 1 reps").fill("5");
  await m.getByLabel("Barbell back squat set 1 weight").fill("60");
  await m.getByRole("button", { name: "Save" }).first().click();
  await expect(m.getByText("Saved.").first()).toBeVisible();
  await m.getByLabel("Plank set 1 seconds").fill("45");
  await m
    .getByTestId("exercise")
    .nth(1)
    .getByRole("button", { name: "Save" })
    .first()
    .click();
  await expect(
    m.getByTestId("exercise").nth(1).getByText("Saved."),
  ).toBeVisible();
  await m.getByLabel("How hard was it? (1 easy – 10 maximum)").fill("7");
  await m.getByRole("button", { name: "Finish workout" }).click();
  await expect(
    m.getByText(/Workout done\. \d+ personal records?!/),
  ).toBeVisible();
  await expect(m.getByTestId("new-records")).toContainText(
    "Barbell back squat: 60 kg",
  );
  await noHorizontalScroll(m);

  // The trainer sees it and leaves feedback.
  await t.reload();
  const workout = t.getByTestId("workout").first();
  await expect(workout).toContainText("PR");
  await workout
    .getByLabel("Feedback")
    .fill("Great depth. Add 2.5 kg next time.");
  await workout.getByRole("button", { name: "Send" }).click();
  await expect(t.getByText(/The member gets a notification/)).toBeVisible();

  // The member is notified and reads it on the workout.
  await m.goto("/m/");
  await expect(
    m.getByRole("link", { name: /Notifications, \d+ unread/ }),
  ).toBeVisible();
  await m.getByRole("link", { name: /Notifications/ }).click();
  await expect(m.getByTestId("member-notifications")).toContainText(
    "Coach Meera left you feedback",
  );
  await m.getByText("Coach Meera left you feedback").click();
  await expect(m.getByTestId("feedback")).toContainText("Great depth");
  await m.goto("/m/progress");
  await expect(m.getByRole("heading", { name: "Progress" })).toBeVisible();
  await noHorizontalScroll(m);
  await mctx.close();
  await sctx.close();
});

test("referral link → lead → paid membership → referrer gets the points", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const gym = await createFitnessGym();
  await memberSignIn(page, gym.referrer.email, gym.referrer.password);
  await page.goto("/m/rewards");
  const link = (await page
    .getByTestId("referral")
    .locator("p.font-mono")
    .textContent())!.trim();
  expect(link).toMatch(/\/r\/[a-z0-9-]+\/[A-Z0-9]{8}$/);
  await noHorizontalScroll(page);

  // A friend opens the link (not signed in) and leaves their number.
  const friendCtx = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const f = await friendCtx.newPage();
  await f.goto(new URL(link).pathname);
  await expect(
    f.getByRole("heading", { name: `${gym.referrer.name} invited you` }),
  ).toBeVisible();
  const phone = `98${String(Date.now()).slice(-8)}`;
  await f.getByLabel("Your name").fill("Friend");
  await f.getByLabel("Mobile number").fill(phone);
  await f.getByRole("checkbox").check();
  await f.getByRole("button", { name: "Send" }).click();
  await expect(
    f.getByText("Thanks! The gym will call you soon."),
  ).toBeVisible();
  await noHorizontalScroll(f);
  await friendCtx.close();

  // The gym converts the lead and the friend pays (the worker then rewards the referrer).
  await friendJoinsAndPays(gym.ctx, gym.tenantId, phone, gym.planId);
  await page.reload();
  await expect(page.getByTestId("points")).toContainText("500");
  await expect(page.getByTestId("referral")).toContainText("joined, +500");
});
