import { expect, test, type Page } from "@playwright/test";
import { createFloorGym, memberSignIn, passOtp, signIn } from "./fixtures";

// Every M3 screen renders, without sideways scrolling, on desktop (1366 px) and phone (390 px).
// Screenshots land in test-results/ for a visual check.

async function noHorizontalScroll(page: Page) {
  const { overflow, culprits } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const culprits = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .slice(-3)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 120));
    return {
      overflow: document.documentElement.scrollWidth - width,
      culprits,
    };
  });
  expect(
    overflow,
    `page scrolls sideways: ${culprits.join(" | ")}`,
  ).toBeLessThanOrEqual(1);
}

async function visit(page: Page, path: string, heading: RegExp, shot: string) {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { name: heading }).first(),
  ).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath(`${shot}.png`),
    fullPage: true,
  });
}

test("staff M3 screens", async ({ page }) => {
  test.setTimeout(120_000);
  const { owner, members } = await createFloorGym(["Kiran"]);
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();

  await visit(page, "/scan", /Scan member passes/, "scan");
  await visit(page, "/attendance", /Check-ins/, "attendance");
  await visit(page, "/classes", /^Classes$/, "classes-week");
  await visit(
    page,
    "/classes/templates/new",
    /New recurring class/,
    "template-new",
  );
  await visit(page, "/classes/setup", /Rooms & categories/, "classes-setup");
  await visit(page, "/pt", /Personal training/, "pt");
  await visit(page, "/pt/packages", /PT packages/, "pt-packages");
  await visit(page, "/settings/floor", /Settings/, "settings-floor");
  await visit(
    page,
    `/members/${members[0]!.memberId}?tab=attendance`,
    /Kiran/,
    "member-checkins",
  );
  await visit(
    page,
    `/members/${members[0]!.memberId}?tab=training`,
    /Kiran/,
    "member-training",
  );

  // A recurring class, then its session page.
  await page.goto("/classes/templates/new");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Screen Yoga");
  await page.getByRole("button", { name: "Create class and schedule" }).click();
  await expect(page.getByText(/Screen Yoga saved/)).toBeVisible();
  await page.goto("/classes?view=week");
  // Mon/Wed/Fri classes: late in the week the next session is in the following week.
  const yoga = page.getByRole("link", { name: /Screen Yoga/ }).first();
  await expect(page.getByRole("heading", { name: "Classes" })).toBeVisible();
  if (!(await yoga.isVisible()))
    await page.getByRole("link", { name: /Next week/ }).click();
  await yoga.click();
  await expect(
    page.getByRole("heading", { name: "Screen Yoga" }),
  ).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath("session.png"),
    fullPage: true,
  });

  // The owner's own staff page (hours, trainer profile).
  await page.goto("/staff");
  await page.getByRole("link", { name: owner.name }).click();
  await expect(page.getByRole("heading", { name: owner.name })).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath("staff-profile.png"),
    fullPage: true,
  });
});

test("member M3 screens", async ({ page }) => {
  test.setTimeout(90_000);
  const { members } = await createFloorGym(["Leela"]);
  await memberSignIn(page, members[0]!.email, members[0]!.password);
  await visit(page, "/m/", /Hi, Leela/, "m-home");
  await page.goto("/m/card");
  await expect(page.getByTestId("pass-qr")).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath("m-card.png"),
    fullPage: true,
  });
  await visit(page, "/m/classes", /Classes/, "m-classes");
  await visit(page, "/m/check-ins", /Check-ins/, "m-checkins");
  await visit(page, "/m/pt", /Personal training/, "m-pt");
});
