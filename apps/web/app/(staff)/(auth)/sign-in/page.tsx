import {
  ActionForm,
  Alert,
  AuthCard,
  Button,
  FormField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getSessionState, safeNext } from "@/lib/session";
import { signInAction, signInWithGoogleAction } from "../actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const state = await getSessionState();
  if (state.kind !== "anonymous" && state.kind !== "deactivated")
    redirect(next);
  const { brand, googleEnabled } = services();

  return (
    <AuthCard
      brand={brand}
      title="Sign in"
      description="Staff and owners sign in here."
      footer={
        <>
          New gym?{" "}
          <a className="font-medium text-primary underline" href="/sign-up">
            Create an account
          </a>
        </>
      }
    >
      {params.reset && (
        <Alert tone="success" className="mb-4">
          Password changed. Sign in with your new password.
        </Alert>
      )}
      {params.deactivated && (
        <Alert tone="warning" className="mb-4">
          This account has been deactivated.
        </Alert>
      )}
      {params.error && (
        <Alert tone="danger" className="mb-4">
          Google sign-in didn&apos;t work. Try again or use your password.
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
        <div className="flex justify-end text-sm">
          <a className="text-primary underline" href="/forgot-password">
            Forgot password?
          </a>
        </div>
        <SubmitButton className="w-full">Sign in</SubmitButton>
      </ActionForm>
      {googleEnabled && (
        <form action={signInWithGoogleAction} className="mt-4">
          <input type="hidden" name="next" value={next} />
          <div className="mb-4 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" /> or{" "}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button type="submit" variant="outline" className="w-full">
            Continue with Google
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
