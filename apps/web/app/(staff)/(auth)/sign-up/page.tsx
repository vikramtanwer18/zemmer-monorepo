import { ActionForm, AuthCard, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { safeNext } from "@/lib/session";
import { signUpAction } from "../actions";

export const metadata: Metadata = { title: "Create your account" };

export default async function SignUpPage({
  searchParams,
}: PageProps<"/sign-up">) {
  const params = await searchParams;
  const next = safeNext(params.next, "/onboarding");
  const email = typeof params.email === "string" ? params.email : undefined;
  // People joining a gym as members arrive from the join link or the member app.
  const asMember = next.startsWith("/join/") || next.startsWith("/m/");
  return (
    <AuthCard
      brand={services().brand}
      title="Create your account"
      description={
        asMember
          ? "Create an account to join your gym."
          : "Start a free trial for your gym. No card needed."
      }
      footer={
        <>
          Already have an account?{" "}
          <a
            className="font-medium text-primary underline"
            href={`${asMember ? "/m/sign-in" : "/sign-in"}?next=${encodeURIComponent(next)}`}
          >
            Sign in
          </a>
        </>
      }
    >
      <ActionForm action={signUpAction} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <FormField label="Your name" name="name" autoComplete="name" required />
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={email}
          required
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          required
        />
        <SubmitButton className="w-full">Create account</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
