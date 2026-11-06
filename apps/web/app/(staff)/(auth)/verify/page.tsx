import {
  ActionForm,
  AuthCard,
  Button,
  CheckboxField,
  FormField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";
import { sendOtpAction, signOutAction, verifyOtpAction } from "../actions";

export const metadata: Metadata = { title: "Enter your code" };

export default async function VerifyPage() {
  const state = await getSessionState();
  if (state.kind === "anonymous" || state.kind === "deactivated")
    redirect("/sign-in");
  if (state.kind !== "mfa-required") redirect("/");

  return (
    <AuthCard
      brand={services().brand}
      title="Check it's you"
      description={
        <>
          {state.access.tenant.displayName} requires a one-time code for your
          role. We&apos;ll email it to{" "}
          <strong className="text-foreground">{state.user.email}</strong>.
        </>
      }
      footer={
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      }
    >
      <ActionForm action={sendOtpAction} className="mb-6">
        <SubmitButton variant="outline" className="w-full">
          Email me a code
        </SubmitButton>
      </ActionForm>
      <ActionForm action={verifyOtpAction} className="flex flex-col gap-4">
        <FormField
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
        {state.trustedDeviceAllowed && (
          <CheckboxField
            name="trust"
            label="Trust this device for 30 days"
            hint="Only on a device you don't share."
          />
        )}
        <SubmitButton className="w-full">Verify</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
