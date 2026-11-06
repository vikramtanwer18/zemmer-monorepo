import { referralLanding } from "@gym/core/engagement";
import { ActionForm, CheckboxField, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { services } from "@/lib/services";
import { submitReferralAction } from "./actions";

export const metadata: Metadata = { title: "You're invited" };

/** /r/{gym}/{code}: a member's invite link. Shows only the gym and the member's first name. */
export default async function ReferralPage({
  params,
}: PageProps<"/r/[tenant]/[code]">) {
  const { tenant, code } = await params;
  const landing = await referralLanding(services().deps, tenant, code);
  if (!landing) notFound();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-4 py-8">
      <p className="text-sm font-semibold text-primary">{landing.gymName}</p>
      <h1 className="text-2xl font-semibold">
        {landing.referrerFirstName} invited you
      </h1>
      <p className="text-muted">
        Leave your number and {landing.gymName} will call you about a free
        trial.
      </p>
      <ActionForm
        action={submitReferralAction}
        resetOnSuccess
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="tenant" value={tenant} />
        <input type="hidden" name="code" value={code} />
        {/* Honeypot: people never see or fill this. */}
        <div aria-hidden="true" className="hidden">
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <FormField
          label="Your name"
          name="firstName"
          required
          autoComplete="given-name"
        />
        <FormField
          label="Mobile number"
          name="phone"
          required
          inputMode="tel"
          autoComplete="tel"
        />
        <FormField
          label="Email (optional)"
          name="email"
          type="email"
          autoComplete="email"
        />
        <CheckboxField name="consent" label={landing.consentText} required />
        <SubmitButton>Send</SubmitButton>
      </ActionForm>
      <p className="text-xs text-muted">
        Your details go only to {landing.gymName}. {landing.referrerFirstName}{" "}
        won&apos;t see your number.
      </p>
    </main>
  );
}
