import { getPlatformSettingsForAdmin, listPlans } from "@gym/core/platform";
import {
  ActionForm,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { updateSettingsAction } from "../actions";

export const metadata: Metadata = { title: "Platform settings" };

export default async function SettingsPage() {
  const { ctx } = await requireAdmin("/settings");
  const { deps } = services();
  const [settings, { plans }] = await Promise.all([
    getPlatformSettingsForAdmin(deps, ctx),
    listPlans(deps, ctx),
  ]);
  const canEdit = ctx.permissions.has("platform.settings.manage");
  const codes = [
    ...new Set(plans.filter((p) => p.status === "ACTIVE").map((p) => p.code)),
  ];

  return (
    <>
      <PageHeader
        title="Platform settings"
        description="How new gyms join and how trials end."
      />
      <ActionForm
        action={updateSettingsAction}
        className="flex max-w-xl flex-col gap-4"
      >
        <fieldset disabled={!canEdit} className="flex flex-col gap-4">
          <CheckboxField
            name="approvalRequired"
            label="New self-signup gyms need approval"
            hint="They wait on a 'we're reviewing your gym' screen until a platform admin approves them."
            defaultChecked={settings["tenant.approval_required"]}
          />
          <FormField
            label="Trial length (days)"
            name="trialDays"
            type="number"
            min={0}
            max={365}
            defaultValue={settings["trial.days"]}
            required
          />
          <SelectField
            label="Trial plan"
            name="trialPlanCode"
            options={codes.map((c) => ({ value: c, label: c }))}
            defaultValue={settings["trial.plan_code"]}
          />
          <SelectField
            label="When a trial ends"
            name="trialExpiredStatus"
            options={[
              {
                value: "SUSPENDED",
                label: "Suspend (read-only until they pay)",
              },
              { value: "GRACE", label: "Grace period (still fully usable)" },
              {
                value: "PAST_DUE",
                label: "Past due (still fully usable, flagged)",
              },
            ]}
            defaultValue={settings["trial.expired_status"]}
          />
          <CheckboxField
            name="embeddedSignupEnabled"
            label="Gyms can connect WhatsApp with Meta Embedded Signup"
            hint="Only after Meta approves us as a Tech Provider and META_APP_ID and META_EMBEDDED_SIGNUP_CONFIG_ID are set on the gym app. Until then gyms use Manual Connect and see “coming soon”."
            defaultChecked={settings["whatsapp.embedded_signup_enabled"]}
          />
        </fieldset>
        {canEdit && (
          <div>
            <SubmitButton>Save settings</SubmitButton>
          </div>
        )}
      </ActionForm>
    </>
  );
}
