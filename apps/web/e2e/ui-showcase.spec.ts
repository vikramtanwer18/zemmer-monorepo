import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// M0: the /ui showcase renders every component and has no serious or critical WCAG 2.1 AA
// violations. Runs on desktop and the mobile project.

test("the design-system showcase has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/ui");
  await expect(
    page.getByRole("heading", { name: "Design system" }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
});

test("dialogs open, trap focus and close with Escape", async ({ page }) => {
  await page.goto("/ui");
  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Freeze membership" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open dialog" })).toBeFocused();
});

test("forms show field errors and success from the server action", async ({
  page,
}) => {
  await page.goto("/ui");
  const submit = page.getByRole("button", { name: "Submit" });
  await submit.click();
  await expect(page.getByText("Enter a name.")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Asha");
  await submit.click();
  await expect(page.getByText("Saved Asha.")).toBeVisible();
});
