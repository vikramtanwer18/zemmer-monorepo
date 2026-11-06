import { hasPermission } from "@gym/core/authz";
import { CAMPAIGN_CHANNELS, listCampaigns } from "@gym/core/crm";
import { fromDbDate } from "@gym/core/time/dates";
import {
  ActionForm,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { day, inr } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  archiveCampaignAction,
  saveCampaignAction,
} from "../../settings/crm/actions";
import { LeadsTabs } from "../leads-tabs";

export const metadata: Metadata = { title: "Campaigns" };

const label = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();

export default async function CampaignsPage({
  searchParams,
}: PageProps<"/leads/campaigns">) {
  const { ctx } = await requireReady("/leads/campaigns");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const campaigns = await orUpgrade(listCampaigns(services().deps, ctx));
  if (!campaigns)
    return <UpgradeNotice title="Campaigns" feature="Leads and CRM" />;
  const canEdit = hasPermission(ctx, "crm.configure");
  return (
    <>
      <PageHeader
        title="Leads"
        description="Campaigns are what you track: an ad, a flyer drop, an event. Use the code as utm_campaign in links so enquiries are credited automatically."
      />
      <LeadsTabs current="/leads/campaigns" />
      <Flash params={sp} />
      <DataTable
        caption="Campaigns"
        rows={campaigns}
        rowKey={(c) => c.id}
        empty={
          <EmptyState
            title="No campaigns yet"
            description={
              canEdit ? "Add one below." : "An owner or admin can add them."
            }
          />
        }
        columns={[
          {
            key: "name",
            header: "Campaign",
            cell: (c) => (
              <span className="flex flex-col">
                <span className="font-medium">{c.name}</span>
                <code className="text-xs text-muted">
                  utm_campaign={c.code}
                </code>
              </span>
            ),
          },
          { key: "channel", header: "Channel", cell: (c) => label(c.channel) },
          {
            key: "dates",
            header: "Runs",
            hideOnMobile: true,
            cell: (c) =>
              c.startsOn
                ? `${day(fromDbDate(c.startsOn))} – ${c.endsOn ? day(fromDbDate(c.endsOn)) : "open"}`
                : "—",
          },
          {
            key: "budget",
            header: "Budget",
            hideOnMobile: true,
            cell: (c) => (c.budgetMinor !== null ? inr(c.budgetMinor) : "—"),
          },
          {
            key: "leads",
            header: "Leads",
            cell: (c) => (
              <a
                className="text-primary underline"
                href={`/leads?status=ALL&campaignId=${c.id}`}
              >
                {c.leads}
              </a>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (c) =>
              canEdit ? (
                <ConfirmDialog
                  trigger="Archive"
                  title={`Archive ${c.name}?`}
                  description="It stays on its leads and in reports; new enquiries are no longer matched to it."
                  confirmLabel="Archive"
                  formAction={archiveCampaignAction}
                  fields={{ campaignId: c.id }}
                />
              ) : null,
          },
        ]}
      />
      {canEdit && (
        <section aria-labelledby="new" className="mt-8 max-w-2xl">
          <h2 id="new" className="mb-3 text-base font-semibold">
            New campaign
          </h2>
          <ActionForm
            action={saveCampaignAction}
            resetOnSuccess
            className="flex flex-col gap-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Name"
                name="name"
                required
                placeholder="Diwali 2026 offer"
              />
              <SelectField
                label="Channel"
                name="channel"
                options={CAMPAIGN_CHANNELS.map((c) => ({
                  value: c,
                  label: label(c),
                }))}
              />
              <FormField
                label="Tracking code"
                name="code"
                required
                placeholder="diwali-2026"
                hint="Goes in links as utm_campaign."
              />
              <FormField
                label="Budget (₹, optional)"
                name="budget"
                inputMode="decimal"
              />
              <FormField label="Starts" name="startsOn" type="date" />
              <FormField label="Ends" name="endsOn" type="date" />
            </div>
            <div>
              <SubmitButton>Add campaign</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
