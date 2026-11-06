import { hasPermission } from "@gym/core/authz";
import { crmStaffOptions, getCrmSetup } from "@gym/core/crm";
import {
  ActionForm,
  Breadcrumbs,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { createLeadAction } from "../actions";

export const metadata: Metadata = { title: "Add lead" };

export default async function NewLeadPage() {
  const { ctx, access } = await requireReady("/leads/new");
  if (!hasPermission(ctx, "leads.manage")) return <NoAccess />;
  const setup = await orUpgrade(getCrmSetup(services().deps, ctx));
  if (!setup) return <UpgradeNotice title="Add lead" feature="Leads and CRM" />;
  const branches = access.branches.filter((b) =>
    hasPermission(ctx, "leads.manage", { branchId: b.id }),
  );
  const branchId = ctx.activeBranchId ?? branches[0]?.id;
  const staff = await crmStaffOptions(services().deps, ctx, branchId ?? null);
  const canAssign = hasPermission(ctx, "leads.assign");
  return (
    <>
      <Breadcrumbs
        items={[{ label: "Leads", href: "/leads" }, { label: "Add lead" }]}
      />
      <PageHeader
        title="Add a lead"
        description="A walk-in, a phone call or a message. A first-contact task is created for the owner."
      />
      <ActionForm
        action={createLeadAction}
        className="flex max-w-2xl flex-col gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="First name"
            name="firstName"
            required
            autoComplete="off"
          />
          <FormField label="Last name" name="lastName" autoComplete="off" />
          <FormField
            label="Mobile"
            name="phone"
            inputMode="tel"
            hint="10 digits, e.g. 98765 43210"
          />
          <FormField label="Email" name="email" type="email" />
          <SelectField
            label="Branch"
            name="branchId"
            defaultValue={branchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
          <SelectField
            label="Source"
            name="sourceId"
            placeholder="Pick one"
            options={setup.sources.map((s) => ({ value: s.id, label: s.name }))}
          />
          <SelectField
            label="Campaign (optional)"
            name="campaignId"
            placeholder="None"
            options={setup.campaigns.map((c) => ({
              value: c.id,
              label: c.name,
            }))}
          />
          <SelectField
            label="Owner"
            name="ownerUserId"
            defaultValue={canAssign ? "" : ctx.userId}
            placeholder={
              setup.settings.leadAssignment === "ROUND_ROBIN"
                ? "Next in rotation"
                : "Nobody yet"
            }
            options={staff
              .filter((s) => canAssign || s.userId === ctx.userId)
              .map((s) => ({
                value: s.userId,
                label: s.userId === ctx.userId ? `${s.name} (me)` : s.name,
              }))}
          />
        </div>
        <FormField
          label="Interested in"
          name="interest"
          placeholder="e.g. weight loss, morning batch, couple plan"
        />
        <TextareaField label="Note" name="note" rows={3} />
        <fieldset className="flex flex-col gap-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Consent</legend>
          <CheckboxField
            name="consent"
            label="They agreed to be contacted about joining"
            hint="Ask them; their yes is recorded with the date."
          />
          <CheckboxField
            name="marketingConsent"
            label="They want offers and news too"
            hint="Only if they said yes. Needed before any promotional message."
          />
        </fieldset>
        <CheckboxField
          name="confirmDuplicate"
          label="Add anyway if this mobile or email is already here"
          hint="Only for family members sharing a number. Otherwise open the existing lead or member."
        />
        <div>
          <SubmitButton>Add lead</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
