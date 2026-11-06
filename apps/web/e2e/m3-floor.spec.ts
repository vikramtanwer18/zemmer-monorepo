import { expect, test, type Page } from "@playwright/test";
import { createFloorGym, memberSignIn, passOtp, signIn } from "./fixtures";

test.skip(({ isMobile }) => isMobile, "flows run on desktop only");

/** The QR value on the member's card (the camera is mocked by typing it into the scan page). */
async function cardCode(member: Page) {
  const qr = member.getByTestId("pass-qr");
  await expect(qr).toBeVisible();
  const code = await qr.getAttribute("data-code");
  expect(code).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{16}$/);
  return code!;
}

// M3 main paths (D-09 + bookings): card → staff scan → accepted → history; same code again →
// "already used"; class full → waitlist → a cancellation promotes the next member.
test("QR check-in from the member card, and replay is refused", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { owner, members } = await createFloorGym(["Asha"]);
  const [asha] = members;

  // Member opens the card.
  const memberContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const member = await memberContext.newPage();
  await memberSignIn(member, asha!.email, asha!.password);
  await member.goto("/m/card");
  await expect(member.getByText(asha!.name, { exact: true })).toBeVisible();
  await expect(member.getByText("Active", { exact: true })).toBeVisible();
  await expect(member.getByText(/New code in \d+s/)).toBeVisible();
  const code = await cardCode(member);

  // Staff scans it (keyboard-wedge input = the camera's decoded value).
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
  await page.goto("/scan");
  await page.getByLabel("Scanner input").fill(code);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const result = page.getByTestId("scan-result");
  await expect(result).toHaveAttribute("data-result", "ACCEPTED");
  await expect(result.getByText("Checked in")).toBeVisible();
  await expect(result.getByText(asha!.name)).toBeVisible();

  // The same code again (a screenshot) is refused.
  await page.getByLabel("Scanner input").fill(code);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(result).toHaveAttribute("data-result", "REJECTED");
  await expect(result.getByText(/already been used/)).toBeVisible();

  // History: the member sees the check-in; staff see both scans today.
  await member.goto("/m/check-ins");
  await expect(
    member.getByTestId("checkin-list").getByRole("listitem"),
  ).toHaveCount(1);
  await expect(member.getByTestId("streak")).toHaveText("1 day");
  await page.goto("/attendance");
  const table = page.getByRole("table", { name: "Check-ins" });
  await expect(table.getByText("Refused", { exact: true })).toBeVisible();
  await expect(table.getByText("In", { exact: true })).toBeVisible();
  await expect(table.getByRole("link", { name: asha!.name })).toHaveCount(2);

  // The pass secret never reaches the browser cache: the card API says no-store.
  const api = await member.request.get("/api/m/card");
  expect(api.headers()["cache-control"]).toContain("no-store");
  // Signed out, the card API refuses.
  const anonymous = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  expect((await anonymous.request.get("/api/m/card")).status()).toBe(401);
  await anonymous.close();
  await memberContext.close();
});

test("a full class puts members on the waitlist and a cancellation promotes them", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const { owner, members } = await createFloorGym(["Ravi", "Nina"]);
  const [ravi, nina] = members;

  // Staff create a one-off class tomorrow with one place.
  await signIn(page, owner.email, owner.password);
  await passOtp(page, owner.email);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible();
  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Kolkata" },
  );
  await page.goto("/classes/sessions/new");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("E2E Spin");
  await page.getByLabel("Date").fill(tomorrow);
  await page.getByLabel("Start time").fill("18:00");
  await page.getByLabel("Places").fill("1");
  await page.getByRole("button", { name: "Create class" }).click();
  await expect(page.getByRole("heading", { name: "E2E Spin" })).toBeVisible();
  const sessionUrl = new URL(page.url()).pathname;

  const open = async (who: { email: string; password: string }) => {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    const p = await context.newPage();
    await memberSignIn(p, who.email, who.password);
    await p.goto(`/m/classes?day=${tomorrow}`);
    return { context, p };
  };

  // Ravi books the only place.
  const r = await open(ravi!);
  const raviCard = r.p
    .getByTestId("class-card")
    .filter({ hasText: "E2E Spin" });
  await raviCard.getByRole("button", { name: "Book" }).click();
  await expect(r.p.getByText("Booked. See you there!")).toBeVisible();

  // Nina finds it full and joins the waitlist.
  const n = await open(nina!);
  const ninaCard = n.p
    .getByTestId("class-card")
    .filter({ hasText: "E2E Spin" });
  await expect(ninaCard.getByText("Full")).toBeVisible();
  await ninaCard.getByRole("button", { name: "Join waitlist" }).click();
  await expect(n.p.getByText(/number 1 on the waitlist/)).toBeVisible();

  // Ravi cancels: Nina moves up automatically.
  await r.p
    .getByTestId("class-card")
    .filter({ hasText: "E2E Spin" })
    .getByRole("button", { name: "Cancel booking" })
    .click();
  await expect(r.p.getByText(/Your place has been released/)).toBeVisible();
  await n.p.reload();
  await expect(
    n.p
      .getByTestId("class-card")
      .filter({ hasText: "E2E Spin" })
      .getByText("Booked"),
  ).toBeVisible();

  // Staff see the roster: Nina, from the waitlist.
  await page.goto(sessionUrl);
  await expect(page.getByTestId("booked-count")).toHaveText("1/1");
  await expect(page.getByText(/from waitlist/)).toBeVisible();
  await r.context.close();
  await n.context.close();
});
