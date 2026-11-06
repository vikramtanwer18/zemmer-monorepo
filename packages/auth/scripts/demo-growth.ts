/**
 * M6 demo: Iron Temple connects the TEST WhatsApp provider (sends nothing), syncs its templates,
 * maps the renewal reminder, saves an audience and a draft campaign, installs the five ready-made
 * workflows (expiry reminders switched on) and computes retention flags once.
 * Only runs when WHATSAPP_FAKE_ENABLED=true (refused in production by the env checks).
 */
import type { AuthContext } from "@gym/core/authz";
import {
  installLibraryWorkflow,
  setWorkflowEnabled,
} from "@gym/core/automation";
import { createSecretBox } from "@gym/core/crypto";
import { saveCampaign } from "@gym/core/crm";
import { noEntitlementCache } from "@gym/core/entitlements";
import { configureCampaignSend, saveSegment } from "@gym/core/growth";
import {
  connectWhatsAppAccount,
  getWhatsAppAccount,
  listTemplates,
  saveNotificationTemplate,
} from "@gym/core/messaging";
import { runRetentionTx } from "@gym/core/retention";
import { todayIn } from "@gym/core/time/dates";
import { withTenant, type PrismaClient } from "@gym/db";
import { memoryFakeStore } from "@gym/integrations/payments";
import { whatsappClientFactory } from "@gym/integrations/whatsapp";

export async function seedGrowthDemo(db: PrismaClient, ctx: AuthContext) {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (!key)
    throw new Error(
      "DATA_ENCRYPTION_KEY must be set to seed WhatsApp demo data.",
    );
  const deps = {
    db,
    entitlements: noEntitlementCache,
    secrets: createSecretBox({
      key,
      previousKey: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
    }),
    // Verify/subscribe/list only: the fake keeps nothing that the web app needs to share.
    whatsapp: whatsappClientFactory({
      fakeEnabled: true,
      store: memoryFakeStore(),
    }),
  };
  if (await getWhatsAppAccount(deps, ctx)) return false;
  await connectWhatsAppAccount(
    deps,
    ctx,
    {
      method: "FAKE",
      wabaId: "100200300400",
      phoneNumberId: "500600700800",
      accessToken: "EAAG-demo-test-provider-token",
    },
    { allowFake: true },
  );
  const templates = await listTemplates(deps, ctx);
  const byName = (n: string) => templates.find((t) => t.name === n)!;
  await saveNotificationTemplate(deps, ctx, {
    key: "membership.expiring",
    templateId: byName("membership_renewal_reminder").id,
    variables: { "1": "name", "2": "plan", "3": "end" },
  });
  await saveNotificationTemplate(deps, ctx, {
    key: "payment.link",
    templateId: byName("payment_due_reminder").id,
    variables: { "1": "name", "2": "amount", "3": "gym", "4": "url" },
  });
  const segment = await saveSegment(deps, ctx, null, {
    name: "Ending in the next 14 days",
    definition: {
      entity: "MEMBER",
      conditions: [
        { field: "expiresInDays", op: "between", value: { min: 0, max: 14 } },
      ],
    },
  });
  const campaign = await saveCampaign(deps, ctx, null, {
    name: "Festive offer (WhatsApp)",
    channel: "WHATSAPP",
    code: "festive-wa",
  });
  await configureCampaignSend(deps, ctx, campaign.id, {
    segmentId: segment.id,
    templateId: byName("festive_offer").id,
    variableMap: {
      first_name: { source: "first_name" },
      gym: { source: "gym_name" },
    },
    throttlePerMinute: 30,
  });
  let expiryId: string | null = null;
  for (const k of [
    "expiry_reminders",
    "overdue_follow_up",
    "speed_to_lead",
    "trial_no_show",
    "win_back_30",
  ]) {
    const r = await installLibraryWorkflow(deps, ctx, k);
    if (k === "expiry_reminders") expiryId = r.id;
  }
  if (expiryId) await setWorkflowEnabled(deps, ctx, expiryId, true);
  const now = new Date();
  await withTenant(db, ctx.tenantId, (tx) =>
    runRetentionTx(tx, ctx.tenantId, todayIn(ctx.timezone, now), now),
  );
  return true;
}
