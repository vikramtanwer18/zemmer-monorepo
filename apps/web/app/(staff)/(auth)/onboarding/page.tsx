import { GST_STATES } from "@gym/core/gst";
import {
  ActionForm,
  AuthCard,
  FormField,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";
import { onboardingAction } from "../actions";

export const metadata: Metadata = { title: "Set up your gym" };

const STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
].map((tz) => ({ value: tz, label: tz }));

export default async function OnboardingPage() {
  const state = await getSessionState();
  if (state.kind === "anonymous" || state.kind === "deactivated")
    redirect("/sign-in?next=/onboarding");

  return (
    <AuthCard
      brand={services().brand}
      title="Set up your gym"
      description="Two quick steps, then your free trial starts. You can change all of this later."
      footer={
        <a className="text-primary underline" href="/select-tenant">
          I was invited to an existing gym
        </a>
      }
    >
      <ActionForm action={onboardingAction} className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold text-foreground">
            1. Your gym
          </legend>
          <FormField
            label="Gym name"
            name="gymName"
            placeholder="Iron Temple"
            required
          />
          <FormField
            label="Registered business name"
            name="legalName"
            hint="As on your GST or company registration. Leave blank if the same."
          />
          <SelectField
            label="State"
            name="stateCode"
            options={STATE_OPTIONS}
            placeholder="Choose a state"
            required
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label="Timezone"
              name="timezone"
              options={TIMEZONES}
              defaultValue="Asia/Kolkata"
            />
            <SelectField
              label="Currency"
              name="currency"
              options={[{ value: "INR", label: "INR – Indian rupee" }]}
              defaultValue="INR"
            />
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold text-foreground">
            2. Your first branch
          </legend>
          <FormField
            label="Branch name"
            name="branchName"
            placeholder="Main branch"
            required
          />
          <FormField label="City" name="branchCity" />
          <FormField label="Address" name="branchAddress" />
        </fieldset>
        <SubmitButton className="w-full">Start my free trial</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
