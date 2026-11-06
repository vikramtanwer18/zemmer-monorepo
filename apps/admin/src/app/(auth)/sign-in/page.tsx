import { ActionForm, Alert, AuthCard, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getPlatformState, safeNext } from "@/lib/session";
import { signInAction } from "../actions";

export const metadata: Metadata = { title: "Platform sign in" };

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const state = await getPlatformState();
  if (state.kind === "ready") redirect(next);
  if (state.kind === "mfa-required") redirect("/verify");

  return (
    <AuthCard
      brand={`${services().brand} Platform`}
      title="Platform sign in"
      description="For platform operators only. Gym staff sign in on the gym app."
      footer={
        <a className="text-primary underline" href="/forgot-password">
          Forgot password?
        </a>
      }
    >
      {params.reset && (
        <Alert tone="success" className="mb-4">
          Password changed. Sign in with your new password.
        </Alert>
      )}
      <ActionForm action={signInAction} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <SubmitButton className="w-full">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
