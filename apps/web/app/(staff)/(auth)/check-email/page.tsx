import { ActionForm, AuthCard, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { resendVerificationAction } from "../actions";

export const metadata: Metadata = { title: "Check your email" };

export default async function CheckEmailPage({
  searchParams,
}: PageProps<"/check-email">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : "";
  return (
    <AuthCard
      brand={services().brand}
      title="Check your email"
      description={
        <>
          We sent a verification link to{" "}
          <strong className="text-foreground">{email || "your inbox"}</strong>.
          Open it to continue.
        </>
      }
      footer={
        <a className="text-primary underline" href="/sign-in">
          Back to sign in
        </a>
      }
    >
      {email && (
        <ActionForm action={resendVerificationAction}>
          <input type="hidden" name="email" value={email} />
          <SubmitButton variant="outline" className="w-full">
            Send the link again
          </SubmitButton>
        </ActionForm>
      )}
    </AuthCard>
  );
}
