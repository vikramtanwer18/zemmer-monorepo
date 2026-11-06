import { ActionForm, Alert, AuthCard, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";
import { safeNext } from "@/lib/session";
import { memberSignInAction } from "../actions";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function MemberSignInPage({
  searchParams,
}: PageProps<"/m/sign-in">) {
  const params = await searchParams;
  const next = safeNext(params.next, "/m/");
  const state = await getMemberSession();
  if (state.kind !== "anonymous")
    redirect(
      next.startsWith("/m/") || next.startsWith("/join/") ? next : "/m/",
    );
  return (
    <AuthCard
      brand={services().brand}
      title="Sign in"
      description="See your membership, payments and invoices."
      footer={
        <>
          No account yet?{" "}
          <a
            className="font-medium text-primary underline"
            href={`/sign-up?next=${encodeURIComponent(next)}`}
          >
            Create one
          </a>
          . Your gym can also send you an invite.
        </>
      }
    >
      {params.reset && (
        <Alert tone="success" className="mb-4">
          Password changed. Sign in with your new password.
        </Alert>
      )}
      <ActionForm action={memberSignInAction} className="flex flex-col gap-4">
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
        <div className="flex justify-end text-sm">
          <a className="text-primary underline" href="/forgot-password">
            Forgot password?
          </a>
        </div>
        <SubmitButton className="w-full">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
