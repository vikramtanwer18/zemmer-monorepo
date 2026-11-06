import { getJoinPage } from "@gym/core/members";
import {
  ActionForm,
  AuthCard,
  CheckboxField,
  FormField,
  LinkButton,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSignedInUser } from "@/lib/member-session";
import { services } from "@/lib/services";
import { joinGymAction } from "../../m/actions";

export const metadata: Metadata = { title: "Join" };
export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: PageProps<"/join/[slug]">) {
  const { slug } = await params;
  const signedIn = await getSignedInUser();
  const gym = await getJoinPage(services().deps, slug);
  if (!gym || gym.branches.length === 0) notFound();
  const here = `/join/${slug}`;

  return (
    <AuthCard
      brand={services().brand}
      title={`Join ${gym.displayName}`}
      description={
        gym.needsApproval
          ? "The gym will confirm your request."
          : "You'll get the member app straight away."
      }
    >
      {!signedIn ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Create an account or sign in to continue.
          </p>
          <LinkButton href={`/sign-up?next=${encodeURIComponent(here)}`}>
            Create an account
          </LinkButton>
          <LinkButton
            href={`/m/sign-in?next=${encodeURIComponent(here)}`}
            variant="outline"
          >
            I have an account
          </LinkButton>
        </div>
      ) : (
        <ActionForm action={joinGymAction} className="flex flex-col gap-4">
          <input type="hidden" name="slug" value={slug} />
          <p className="text-sm text-muted">
            Joining as {signedIn.user.name} ({signedIn.user.email})
          </p>
          <FormField
            label="Mobile number"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
          />
          <SelectField
            label="Branch"
            name="homeBranchId"
            options={gym.branches.map((b) => ({ value: b.id, label: b.name }))}
            defaultValue={
              gym.branches.length === 1 ? gym.branches[0]?.id : undefined
            }
            required
          />
          <CheckboxField
            name="marketingEmail"
            label="Email me offers and news"
          />
          <CheckboxField
            name="marketingWhatsapp"
            label="WhatsApp me offers and news"
          />
          <SubmitButton className="w-full">
            {gym.needsApproval ? "Request to join" : "Join"}
          </SubmitButton>
        </ActionForm>
      )}
    </AuthCard>
  );
}
