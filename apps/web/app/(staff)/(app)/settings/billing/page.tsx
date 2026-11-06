import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getBillingSettings } from "@gym/core/tenancy";
import {
  ActionForm,
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
import { updateBillingSettingsAction } from "../../actions";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Billing settings" };

export default async function BillingSettingsPage() {
  const { ctx } = await requireReady("/settings/billing");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const { settings: s, tenant } = await getBillingSettings(
    services().deps,
    ctx,
  );
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "billing.configure");
  const { appUrl } = services();
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/billing" />
      <ActionForm
        action={updateBillingSettingsAction}
        className="flex max-w-2xl flex-col gap-6"
      >
        <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold">Invoices</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField
              label="Number prefix"
              name="invoicePrefix"
              defaultValue={s?.invoicePrefix ?? "INV"}
              hint="e.g. IT gives IT/26-27/00001"
              required
            />
            <FormField
              label="Due after (days)"
              name="invoiceDueDays"
              type="number"
              min={0}
              defaultValue={s?.invoiceDueDays ?? 0}
            />
            <FormField
              label="Default SAC code"
              name="defaultSacCode"
              defaultValue={s?.defaultSacCode ?? "999723"}
            />
          </div>
          <SelectField
            label="Place of supply"
            name="placeOfSupplyRule"
            defaultValue={s?.placeOfSupplyRule ?? "BRANCH_STATE"}
            hint="Decides CGST + SGST (same state) or IGST. Confirm with your CA."
            options={[
              {
                value: "BRANCH_STATE",
                label: "The branch's state (service performed at the gym)",
              },
              {
                value: "MEMBER_STATE",
                label: "The member's state, when known",
              },
            ]}
          />
        </fieldset>
        <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold">
            Memberships and payments
          </legend>
          <SelectField
            label="Start a new membership"
            name="membershipActivation"
            defaultValue={s?.membershipActivation ?? "FULL_PAYMENT"}
            options={[
              {
                value: "FULL_PAYMENT",
                label: "When the invoice is fully paid",
              },
              { value: "ANY_PAYMENT", label: "With the first payment" },
              { value: "IMMEDIATE", label: "Straight away (dues stay open)" },
            ]}
          />
          <CheckboxField
            name="autoApplyCredit"
            label="Use member credit on new invoices automatically"
            defaultChecked={s?.autoApplyCredit ?? true}
          />
          <FormField
            label="Expiry reminders (days before)"
            name="expiryReminderDays"
            defaultValue={(s?.expiryReminderDays ?? [7, 3, 1]).join(", ")}
            hint="Emailed and shown in the member app."
          />
        </fieldset>
        <fieldset disabled={!canEdit} className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold">Join link</legend>
          <CheckboxField
            name="memberSelfSignup"
            label="Let people join through a link"
            hint={`${appUrl}/join/${tenant.slug}`}
            defaultChecked={s?.memberSelfSignup ?? false}
          />
          <CheckboxField
            name="memberJoinApproval"
            label="Staff approve each new sign-up"
            defaultChecked={s?.memberJoinApproval ?? true}
          />
        </fieldset>
        {canEdit && (
          <div>
            <SubmitButton>Save billing settings</SubmitButton>
          </div>
        )}
      </ActionForm>
    </>
  );
}
