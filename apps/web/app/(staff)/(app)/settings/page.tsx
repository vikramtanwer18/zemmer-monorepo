import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getTenantSettings } from "@gym/core/tenancy";
import {
  ActionForm,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updateProfileAction } from "../actions";
import { LogoUploader } from "./logo-uploader";
import { SettingsTabs } from "./settings-tabs";

export const metadata: Metadata = { title: "Settings" };

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
];
const LOCALES = [
  { value: "en-IN", label: "English (India)" },
  { value: "hi-IN", label: "Hindi (India)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-US", label: "English (US)" },
];

export default async function SettingsPage() {
  const { ctx } = await requireReady("/settings");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const { deps, storage } = services();
  const settings = await getTenantSettings(deps, ctx);
  const canEdit =
    hasPermission(ctx, "settings.manage") && isTenantWritable(ctx);
  const logoUrl = settings.logoKey
    ? await storage.getUrl(settings.logoKey).catch(() => null)
    : null;
  const p = settings.profile;

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings" />
      <div className="grid max-w-3xl gap-8">
        <section aria-labelledby="logo-heading">
          <h2 id="logo-heading" className="mb-3 text-lg font-semibold">
            Logo
          </h2>
          <LogoUploader currentUrl={logoUrl} disabled={!canEdit} />
        </section>
        <section aria-labelledby="profile-heading">
          <h2 id="profile-heading" className="mb-3 text-lg font-semibold">
            Organisation profile
          </h2>
          <ActionForm
            action={updateProfileAction}
            className="flex flex-col gap-4"
          >
            <fieldset disabled={!canEdit} className="flex flex-col gap-4">
              <FormField
                label="Gym name"
                name="displayName"
                defaultValue={p.displayName}
                required
              />
              <FormField
                label="Registered business name"
                name="legalName"
                defaultValue={p.legalName}
                hint="Printed on invoices."
                required
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <SelectField
                  label="Timezone"
                  name="timezone"
                  options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
                  defaultValue={p.timezone}
                />
                <SelectField
                  label="Language and format"
                  name="locale"
                  options={LOCALES}
                  defaultValue={p.locale}
                />
                <SelectField
                  label="Currency"
                  name="currency"
                  options={[{ value: "INR", label: "INR – Indian rupee" }]}
                  defaultValue={p.currency}
                />
              </div>
              <p className="text-xs text-muted">Gym address: {p.slug}</p>
            </fieldset>
            {canEdit && (
              <div>
                <SubmitButton>Save profile</SubmitButton>
              </div>
            )}
          </ActionForm>
        </section>
      </div>
    </>
  );
}
