import { getInvitationPreview } from "@gym/core/tenancy";
import {
  ActionForm,
  Alert,
  AuthCard,
  Button,
  LinkButton,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";
import { acceptInvitationAction, signOutAction } from "../../actions";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitePage({
  params,
}: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const { brand, deps } = services();
  const [preview, state] = await Promise.all([
    getInvitationPreview(deps, token),
    getSessionState(),
  ]);
  const here = `/invite/${token}`;

  if (!preview || preview.state !== "PENDING") {
    const message = !preview
      ? "This invitation link is not valid."
      : preview.state === "EXPIRED"
        ? "This invitation has expired. Ask the gym to send a new one."
        : preview.state === "ACCEPTED"
          ? "This invitation has already been accepted."
          : "This invitation was cancelled.";
    return (
      <AuthCard brand={brand} title="Invitation">
        <Alert tone="warning">{message}</Alert>
        <p className="mt-4 text-sm">
          <a className="text-primary underline" href="/sign-in">
            Go to sign in
          </a>
        </p>
      </AuthCard>
    );
  }

  const signedIn = state.kind !== "anonymous" && state.kind !== "deactivated";
  const sameEmail = signedIn && state.user.email === preview.email;

  return (
    <AuthCard
      brand={brand}
      title={`Join ${preview.tenantName}`}
      description={
        <>
          You&apos;ve been invited as{" "}
          <strong className="text-foreground">
            {preview.roles.join(", ")}
          </strong>
          . The invitation is for{" "}
          <strong className="text-foreground">{preview.email}</strong>.
        </>
      }
    >
      {!signedIn && (
        <div className="flex flex-col gap-3">
          <LinkButton
            className="w-full"
            href={`/sign-up?next=${encodeURIComponent(here)}&email=${encodeURIComponent(preview.email)}`}
          >
            Create my account
          </LinkButton>
          <LinkButton
            variant="outline"
            className="w-full"
            href={`/sign-in?next=${encodeURIComponent(here)}`}
          >
            I already have an account
          </LinkButton>
        </div>
      )}
      {signedIn && !sameEmail && (
        <div className="flex flex-col gap-4">
          <Alert tone="warning">
            You&apos;re signed in as {state.user.email}. Sign out and use{" "}
            {preview.email} to accept.
          </Alert>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" className="w-full">
              Sign out
            </Button>
          </form>
        </div>
      )}
      {sameEmail && (
        <ActionForm action={acceptInvitationAction}>
          <input type="hidden" name="token" value={token} />
          <SubmitButton className="w-full">Accept invitation</SubmitButton>
        </ActionForm>
      )}
    </AuthCard>
  );
}
