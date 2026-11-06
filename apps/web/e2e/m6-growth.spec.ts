import { fakeWebhooks, signMetaWebhook } from "@gym/integrations/whatsapp";
import { expect, test, type Page } from "@playwright/test";
import {
  createGrowthGym,
  endMembershipIn,
  growthRows,
  passOtp,
  payMembership,
  runGrowthWorker,
  runScans,
  signIn,
} from "./fixtures";

// M6: connect a (fake) WABA → templates synced → audience → campaign → statuses from a signed
// webhook → attribution shows a renewal; then the expiry workflow messages a member once.
// No real WhatsApp message is ever sent (test provider).

test.skip(
  process.env.WHATSAPP_FAKE_ENABLED !== "true",
  "needs WHATSAPP_FAKE_ENABLED=true",
);

async function staffSignIn(
  page: Page,
  owner: { email: string; password: string },
) {
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}

test("WhatsApp campaign: connect, audience, send, delivery status, attribution; expiry workflow runs once", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const gym = await createGrowthGym();
  await staffSignIn(page, gym.owner);

  // 1. Manual Connect with the test provider; templates come in.
  await page.goto("/settings/whatsapp");
  await page.getByLabel("Provider").selectOption("FAKE");
  await page.getByLabel("WhatsApp Business Account ID").fill(gym.waba);
  await page.getByLabel("Phone number ID").fill(gym.phoneNumberId);
  await page
    .getByLabel("System-user access token")
    .fill("EAAG-e2e-test-provider-token");
  await page.getByRole("button", { name: "Check and connect" }).click();
  // The connect form folds away once connected; the account card shows the result.
  await expect(page.getByTestId("whatsapp-account")).toContainText(
    "6 approved of 7",
  );
  await expect(page.getByRole("cell", { name: /festive_offer/ })).toBeVisible();
  await expect(page.getByText("Coming soon")).toBeVisible();
  await noHorizontalScroll(page);

  // 2. An audience from the campaign tag.
  await page.goto("/campaigns/audiences/edit");
  await page.getByLabel("Name").fill("E2E tagged");
  await page.getByLabel("Tagged (any of)").fill(gym.tag);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("segment-preview")).toContainText(
    /Match now\s*2/,
  );
  await expect(page.getByTestId("segment-preview")).toContainText(
    /Can get promotions\s*2/,
  );
  await page.getByRole("button", { name: "Save audience" }).click();
  await expect(page.getByText("Audience saved.")).toBeVisible();

  // 3. A campaign: template, variables, audience → confirm → launch.
  await page.goto("/campaigns");
  await page.getByLabel("Name").fill("E2E festive");
  await page.getByLabel("Tracking code").fill(`e2e-fest-${Date.now()}`);
  await page.getByRole("button", { name: "New campaign" }).click();
  await expect(page.getByText("Campaign created.")).toBeVisible();
  await page
    .getByLabel("Template")
    .selectOption({ label: "festive_offer (marketing)" });
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.getByLabel("Audience").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(/^Saved\. Check the numbers below/),
  ).toBeVisible();
  const launch = page.getByTestId("launch");
  await expect(launch).toContainText(/Recipients\s*2/);
  await expect(launch).toContainText(/Message type\s*marketing/);
  await launch.getByRole("checkbox").check();
  await launch.getByRole("button", { name: "Launch" }).click();
  await expect(page.getByText(/^Launched/)).toBeVisible();

  // 4. The worker sends; Meta reports one delivery (signed webhook to our endpoint).
  await runGrowthWorker(gym.tenantId);
  const sent = (await growthRows(gym.tenantId)).outbound.filter(
    (m) => m.purpose === "CAMPAIGN" && m.status === "SENT",
  );
  expect(sent).toHaveLength(2);
  const forged = fakeWebhooks.status({
    wabaId: gym.waba,
    phoneNumberId: gym.phoneNumberId,
    messageId: sent[0]!.providerMessageId!,
    status: "delivered",
  });
  expect(
    (
      await request.post("/api/webhooks/whatsapp", {
        data: forged,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signMetaWebhook(forged, "wrong"),
        },
      })
    ).status(),
  ).toBe(401);
  const res = await request.post("/api/webhooks/whatsapp", {
    data: forged,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signMetaWebhook(
        forged,
        process.env.META_APP_SECRET!,
      ),
    },
  });
  expect(res.status()).toBe(200);
  await runGrowthWorker(gym.tenantId);
  await page.reload();
  const stats = page.getByTestId("campaign-stats");
  await expect(stats).toContainText(/Sent\s*2/);
  await expect(stats).toContainText(/Delivered\s*1/);

  // 5. A recipient renews: the campaign is credited (associated, not causal).
  await payMembership(gym.ctx, gym.members[0]!.id, gym.planId);
  await page.reload();
  await expect(page.getByTestId("attribution")).toContainText(
    /Renewed \/ bought\s*1/,
  );
  await noHorizontalScroll(page);

  // 6. Expiry workflow: install, switch on; a member 7 days from the end gets one reminder.
  await page.goto("/automations");
  await page
    .getByRole("button", { name: "Install (switched off)" })
    .first()
    .click();
  await expect(page.getByText(/^Installed, switched off/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Expiry reminder sequence" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch on" }).click();
  await expect(page.getByText(/^Switched on/)).toBeVisible();
  const membershipId = await payMembership(
    gym.ctx,
    gym.members[1]!.id,
    gym.planId,
  );
  await endMembershipIn(gym.tenantId, membershipId, 7);
  expect((await runScans(gym.tenantId)).started).toBe(1);
  expect((await runScans(gym.tenantId)).started).toBe(0);
  await runGrowthWorker(gym.tenantId);
  const rows = await growthRows(gym.tenantId);
  expect(rows.executions).toHaveLength(1);
  expect(rows.outbound.filter((m) => m.purpose === "AUTOMATION")).toHaveLength(
    1,
  );
  await page.reload();
  await expect(
    page.getByRole("cell", { name: gym.members[1]!.name }),
  ).toBeVisible();
  await expect(page.getByText(/waiting/).first()).toBeVisible();
});

test("growth screens load for the owner without sideways scrolling", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const gym = await createGrowthGym();
  await staffSignIn(page, gym.owner);
  for (const path of [
    "/inbox",
    "/campaigns",
    "/campaigns/audiences",
    "/automations",
    "/automations/approvals",
    "/retention",
    "/retention/rules",
    "/settings/whatsapp",
    "/settings/whatsapp/guide",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1").first(), path).toBeVisible();
    await noHorizontalScroll(page).catch((err: unknown) => {
      throw new Error(`${path}: ${String(err)}`);
    });
  }
});
