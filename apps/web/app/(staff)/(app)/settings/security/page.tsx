import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getTenantSettings } from "@gym/core/tenancy";
import {
  ActionForm,
  Alert,
  CheckboxField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updateSecurityAction } from "../../actions";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Security settings" };

export default async function SecuritySettingsPage() {
  const { ctx } = await requireReady("/settings/security");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const settings = await getTenantSettings(services().deps, ctx);
  const canEdit =
    hasPermission(ctx, "settings.manage") && isTenantWritable(ctx);

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/security" />
      <div className="max-w-2xl">
        <Alert tone="info" className="mb-6">
          Owners and administrators always confirm sign-in with a code sent to
          their email.
        </Alert>
        <ActionForm
          action={updateSecurityAction}
          className="flex flex-col gap-4"
        >
          <fieldset disabled={!canEdit}>
            <CheckboxField
              name="require2faForStaff"
              label="Require an email code for all staff"
              hint="Managers, receptionists, sales staff, trainers and accountants confirm sign-in with a code. They may trust a device for 30 days."
              defaultChecked={settings.security.require2faForStaff}
            />
          </fieldset>
          {canEdit && (
            <div>
              <SubmitButton>Save security settings</SubmitButton>
            </div>
          )}
        </ActionForm>
      </div>
    </>
  );
}
