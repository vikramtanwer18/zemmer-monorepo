/**
 * M5 demo: a campaign, a website capture form, and leads at different pipeline stages (one with
 * an overdue first-contact task, one with a trial today). Skipped when the gym already has leads.
 */
import type { AuthContext } from "@gym/core/authz";
import {
  bookTrial,
  createLead,
  getCrmSetup,
  logLeadActivity,
  markLeadLost,
  saveCampaign,
  saveCaptureForm,
  submitPublicForm,
} from "@gym/core/crm";
import { noEntitlementCache } from "@gym/core/entitlements";
import { utcToLocalDateTime } from "@gym/core/time/dates";
import { withTenant, type PrismaClient } from "@gym/db";

export async function seedCrmDemo(
  db: PrismaClient,
  ctx: AuthContext,
  tenantSlug: string,
) {
  const deps = { db, entitlements: noEntitlementCache };
  if ((await withTenant(db, ctx.tenantId, (tx) => tx.lead.count())) > 0)
    return false;
  const branchId = await withTenant(
    db,
    ctx.tenantId,
    async (tx) =>
      (await tx.branch.findFirstOrThrow({ where: { code: "MAIN" } })).id,
  );
  const setup = await getCrmSetup(deps, ctx);
  const source = (code: string) =>
    setup.sources.find((s) => s.code === code)?.id;
  const campaign = await saveCampaign(deps, ctx, null, {
    name: "Diwali 2026 offer",
    channel: "INSTAGRAM",
    code: "diwali-2026",
    budget: "15000",
  });
  const form = await saveCaptureForm(deps, ctx, null, {
    name: "Website enquiry",
    branchId,
    title: "Book your free trial",
    intro: "Leave your number and we'll call you within the hour.",
    fields: ["email", "interest", "preferredTime"],
    consentText:
      "I agree that {gym} may contact me by phone, WhatsApp or email about my enquiry and membership.",
    marketingText: "Send me offers and news (optional)",
    thankYou: "Thanks! We'll call you within the hour.",
  });
  // A website enquiry from the campaign (as a visitor would send it).
  await submitPublicForm(deps, {
    tenantSlug,
    key: form.key,
    body: {
      firstName: "Neha",
      lastName: "Sharma",
      phone: "9811100001",
      email: "neha@example.com",
      interest: "Weight loss",
      consent: "on",
      utm_source: "instagram",
      utm_campaign: "diwali-2026",
    },
  });
  const walkIn = await createLead(deps, ctx, {
    firstName: "Arjun",
    lastName: "Mehta",
    phone: "9811100002",
    branchId,
    sourceId: source("walk_in"),
    interest: "Strength training",
    consent: "on",
  });
  await logLeadActivity(deps, ctx, walkIn.id, {
    type: "CALL",
    outcome: "ANSWERED",
    body: "Wants evening batch. Coming for a trial.",
  });
  await bookTrial(deps, ctx, walkIn.id, {
    mode: "SLOT",
    start: utcToLocalDateTime(
      new Date(Date.now() + 3 * 3_600_000),
      ctx.timezone,
    ),
    minutes: "60",
  });
  const phone = await createLead(deps, ctx, {
    firstName: "Kavya",
    phone: "9811100003",
    branchId,
    sourceId: source("phone"),
    campaignId: campaign.id,
    consent: "on",
  });
  await logLeadActivity(deps, ctx, phone.id, {
    type: "CALL",
    outcome: "NO_ANSWER",
  });
  await createLead(deps, ctx, {
    firstName: "Rohan",
    phone: "9811100004",
    branchId,
    sourceId: source("referral"),
    interest: "Couple plan",
    consent: "on",
  });
  const lost = await createLead(deps, ctx, {
    firstName: "Imran",
    phone: "9811100005",
    branchId,
    sourceId: source("google"),
    consent: "on",
  });
  await markLeadLost(deps, ctx, lost.id, {
    lostReasonId: setup.lostReasons[0]!.id,
    note: "Found a cheaper gym nearby",
  });
  return true;
}
