import { expect, test } from "@playwright/test";

test("the staff app asks anonymous visitors to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("health endpoint returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("member app links a manifest scoped to /m/", async ({ page, request }) => {
  await page.goto("/m");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/m/manifest.webmanifest",
  );

  const manifest = await (await request.get("/m/manifest.webmanifest")).json();
  expect(manifest.scope).toBe("/m/");
  expect(manifest.start_url).toBe("/m/");
});

test("service worker is served with no-cache", async ({ request }) => {
  const response = await request.get("/m/sw.js");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-cache");
  expect(response.headers()["service-worker-allowed"]).toBe("/m/");
});

test("security headers are set", async ({ request }) => {
  const headers = (await request.get("/sign-in")).headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("/m redirects to /m/, inside the service worker scope", async ({
  request,
}) => {
  const response = await request.get("/m?x=1", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(new URL(response.headers()["location"]!, "http://x").pathname).toBe(
    "/m/",
  );
});

test("signed-out visitors to the member app get the member sign-in", async ({
  page,
}) => {
  await page.goto("/m/invoices");
  await expect(page).toHaveURL(/\/m\/sign-in\?next=%2Fm%2Finvoices$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create one" })).toBeVisible();
});

test("a join link for a gym that doesn't take sign-ups is a 404", async ({
  request,
}) => {
  expect((await request.get("/join/no-such-gym")).status()).toBe(404);
});

test("member pages show the offline message when offline", async ({
  page,
  context,
}) => {
  await page.goto("/m/");
  // Wait until the service worker controls the page (it caches /m/offline on install).
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    }
  });

  await context.setOffline(true);
  await page.goto("/m/some-page");
  await expect(
    page.getByRole("heading", { name: "You are offline" }),
  ).toBeVisible();
  await context.setOffline(false);
});
