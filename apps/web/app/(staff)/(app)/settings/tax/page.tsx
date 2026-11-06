import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { GST_STATES } from "@gym/core/gst";
import { getTenantSettings } from "@gym/core/tenancy";
import {
  ActionForm,
  Alert,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updateTaxAction } from "../../actions";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Tax settings" };

const STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

export default async function TaxSettingsPage() {
  const { ctx } = await requireReady("/settings/tax");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const settings = await getTenantSettings(services().deps, ctx);
  const canEdit =
    hasPermission(ctx, "settings.manage") && isTenantWritable(ctx);
  const t = settings.tax;

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/tax" />
      <div className="max-w-2xl">
        <Alert tone="info" className="mb-6">
          These settings decide whether documents are &ldquo;Tax Invoices&rdquo;
          with CGST/SGST or IGST, or plain receipts. Confirm the details with
          your accountant.
        </Alert>
        <ActionForm action={updateTaxAction} className="flex flex-col gap-4">
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <CheckboxField
              name="gstRegistered"
              label="We are registered for GST"
              defaultChecked={t.gstRegistered}
            />
            <FormField
              label="GSTIN"
              name="gstin"
              defaultValue={t.gstin ?? ""}
              hint="15 characters, e.g. 27AAPFU0939F1ZV. Checked against its check digit."
              autoCapitalize="characters"
            />
            <SelectField
              label="State of registration"
              name="stateCode"
              options={STATE_OPTIONS}
              placeholder="Choose a state"
              defaultValue={t.stateCode ?? ""}
              required
            />
            <CheckboxField
              name="pricesIncludeTax"
              label="Prices include tax"
              hint="When on, a ₹1,180 plan is ₹1,000 + ₹180 GST. When off, GST is added on top."
              defaultChecked={t.pricesIncludeTax}
            />
          </fieldset>
          {canEdit && (
            <div>
              <SubmitButton>Save tax settings</SubmitButton>
            </div>
          )}
        </ActionForm>
      </div>
    </>
  );
}
