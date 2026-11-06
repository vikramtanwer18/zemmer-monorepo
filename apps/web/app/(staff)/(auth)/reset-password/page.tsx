import { ActionForm, Alert, AuthCard, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { resetPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const invalid = !token || params.error === "INVALID_TOKEN";
  return (
    <AuthCard brand={services().brand} title="Choose a new password">
      {invalid ? (
        <Alert tone="danger">
          This reset link is invalid or has expired.{" "}
          <a className="underline" href="/forgot-password">
            Ask for a new one
          </a>
          .
        </Alert>
      ) : (
        <ActionForm
          action={resetPasswordAction}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="token" value={token} />
          <FormField
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters. You'll be signed out everywhere else."
            required
          />
          <FormField
            label="Repeat it"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
          />
          <SubmitButton className="w-full">Change password</SubmitButton>
        </ActionForm>
      )}
    </AuthCard>
  );
}
