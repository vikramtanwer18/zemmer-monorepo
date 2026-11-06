import { ActionForm, AuthCard, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { forgotPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      brand={services().brand}
      title="Reset your password"
      description="We'll email you a link to choose a new one."
      footer={
        <a className="text-primary underline" href="/sign-in">
          Back to sign in
        </a>
      }
    >
      <ActionForm action={forgotPasswordAction} className="flex flex-col gap-4">
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <SubmitButton className="w-full">Send reset link</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
