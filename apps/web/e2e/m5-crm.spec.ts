import { expect, test, type Page } from "@playwright/test";
import { testPassword } from "@gym/testing/e2e";
import { createCrmGym, passOtp, signIn } from "./fixtures";

// M5: website form → lead (source + UTM) → task → trial → attended → converted → paid →
// campaign report shows 1 paid member. Plus the public pieces' safety and every CRM screen.

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

const mobile = () => `9${String(Date.now()).slice(-9)}`;

test("a website enquiry is traced to a paid membership and credited to its campaign", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const gym = await createCrmGym();
  const phone = mobile();

  // 1. A visitor fills in the website form from an Instagram campaign link.
  const visitor = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const v = await visitor.newPage();
  await v.goto(
    `/l/${gym.slug}/${gym.formKey}?utm_source=instagram&utm_medium=paid&utm_campaign=${gym.campaign.code}`,
  );
  await v.getByLabel("Your name").fill("Zara");
  await v.getByLabel("Mobile number").fill(phone);
  await v.getByRole("checkbox", { name: /may contact me/ }).check();
  await v.getByRole("button", { name: "Send" }).click();
  await expect(v.getByText("Thanks! We'll call you soon.")).toBeVisible();
  await noHorizontalScroll(v);
  await visitor.close();

  // 2. The lead is there with its source and campaign; the owner takes it and calls.
  await staffSignIn(page, gym.owner);
  await page.goto("/leads");
  await page.getByRole("link", { name: /^Zara/ }).click();
  await expect(page.getByText("E2E Instagram").first()).toBeVisible();
  await expect(page.getByText(/utm instagram \/ paid/).first()).toBeVisible();
  await expect(page.getByText(/^First contact: Zara/)).toBeVisible();
  await page.getByRole("button", { name: /^(Give|Take it)$/ }).click();
  await expect(page.getByText("Owner changed.")).toBeVisible();
  await page.goto("/tasks");
  await expect(page.getByText(/^First contact: Zara/)).toBeVisible();
  await page.getByRole("link", { name: /Zara/ }).first().click();
  await page.getByLabel("What").selectOption("CALL");
  await page.getByLabel("Call outcome").selectOption("ANSWERED");
  await page.getByLabel("Details").fill("Coming for a trial today.");
  await page.getByRole("button", { name: "Log it" }).click();
  await expect(page.getByText("Coming for a trial today.")).toBeVisible();

  // 3. Trial booked, then attended.
  await page.getByText("Book a trial").click();
  await page.getByRole("button", { name: "Book gym visit" }).click();
  await expect(page.getByText("Trial booked.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Came" }).click();
  await expect(page.getByText("Marked as attended.")).toBeVisible();
  await expect(page.getByText("Trial attended").first()).toBeVisible();

  // 4. Convert → sell a membership → pay → the lead is won.
  await page.getByRole("button", { name: "Convert to member" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue to the sale" })
    .click();
  // Creates the member record, then redirects: allow for a busy test server.
  await expect(page).toHaveURL(/\/members\/[0-9a-f-]+\/sell\?leadId=/, {
    timeout: 20_000,
  });
  await expect(
    page.getByText(/it is marked won when this membership is paid/),
  ).toBeVisible();
  await page.getByLabel("Plan").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Preview invoice" }).click();
  await page.getByLabel("Record a payment now").check();
  await page.getByRole("button", { name: "Issue invoice and sell" }).click();
  await expect(page.getByText(/Sold\. Invoice .+ issued\./)).toBeVisible();
  await page.goto("/leads?status=WON");
  await expect(page.getByRole("link", { name: /^Zara/ })).toBeVisible();

  // 5. The campaign report shows one paid member.
  await page.goto("/leads/reports");
  const row = page.getByRole("row", { name: /E2E Instagram/ });
  await expect(row).toContainText("1 (100%)");
  await noHorizontalScroll(page);
  await page.screenshot({
    path: test.info().outputPath("report.png"),
    fullPage: true,
  });
});

test("public capture is tenant-safe: embed policy, unframeable hosted page, API key scope", async ({
  request,
}) => {
  const gym = await createCrmGym();
  const hosted = await request.get(`/l/${gym.slug}/${gym.formKey}`);
  expect(hosted.headers()["x-frame-options"]).toBe("DENY");
  const embed = await request.get(
    `/l/${gym.slug}/${gym.formKey}/embed?utm_source=site`,
  );
  expect(embed.status()).toBe(200);
  expect(embed.headers()["x-frame-options"]).toBeUndefined();
  expect(embed.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self' https://www.example-gym.test",
  );
  expect(await embed.text()).toContain('name="utm_source" value="site"');
  // Wrong gym slug for this form key: not found.
  expect((await request.get(`/l/not-this-gym/${gym.formKey}`)).status()).toBe(
    404,
  );
  // API: key required; creates in the key's gym.
  const body = {
    first_name: "Api",
    phone: mobile(),
    consent: { given: true, text: "I agree to be contacted about my enquiry." },
  };
  expect(
    (await request.post("/api/public/v1/leads", { data: body })).status(),
  ).toBe(401);
  const created = await request.post("/api/public/v1/leads", {
    data: body,
    headers: {
      authorization: `Bearer ${gym.apiKey}`,
      "idempotency-key": `e2e-${testPassword().slice(0, 12)}`,
    },
  });
  expect(created.status()).toBe(201);
  expect((await request.get("/api/public/v1/openapi.json")).status()).toBe(200);
});

test("CRM screens render", async ({ page }) => {
  test.setTimeout(150_000);
  const gym = await createCrmGym();
  await staffSignIn(page, gym.owner);
  for (const [path, heading] of [
    ["/leads/new", /Add a lead/],
    ["/leads/board", /^Leads$/],
    ["/leads/trials", /^Leads$/],
    ["/leads/campaigns", /^Leads$/],
    ["/leads/import", /^Leads$/],
    ["/tasks", /^Tasks$/],
    ["/settings/crm", /^Settings$/],
    ["/settings/crm/forms", /^Settings$/],
    ["/settings/crm/api", /^Settings$/],
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
});
