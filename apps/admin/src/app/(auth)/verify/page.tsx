import { ActionForm, AuthCard, Button, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getPlatformState, safeNext } from "@/lib/session";
import { sendOtpAction, signOutAction, verifyOtpAction } from "../actions";

export const metadata: Metadata = { title: "Enter your code" };

export default async function VerifyPage({
  searchParams,
}: PageProps<"/verify">) {
  const params = await searchParams;
  const state = await getPlatformState();
  if (state.kind === "anonymous") redirect("/sign-in");
  if (state.kind === "ready") redirect("/");

  return (
    <AuthCard
      brand={`${services().brand} Platform`}
      title="Check it's you"
      description={
        <>
          Platform sign-in always needs a one-time code. We&apos;ll email it to{" "}
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
        <input type="hidden" name="next" value={safeNext(params.next)} />
        <FormField
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
        />
        <SubmitButton className="w-full">Verify</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
