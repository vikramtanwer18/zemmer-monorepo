import { Alert, AuthCard, Button } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMemberSession } from "@/lib/member-session";
import { services } from "@/lib/services";
import { memberSignOutAction } from "../actions";

export const metadata: Metadata = { title: "No gym yet" };
export const dynamic = "force-dynamic";

export default async function NoGymPage({
  searchParams,
}: PageProps<"/m/no-gym">) {
  const params = await searchParams;
  const state = await getMemberSession();
  if (state.kind === "anonymous") redirect("/m/sign-in");
  if (state.kind !== "no-gym") redirect("/m/");
  return (
    <AuthCard
      brand={services().brand}
      title={params.requested ? "Request sent" : "No gym yet"}
      description={`Signed in as ${state.user.email}`}
      footer={
        <form action={memberSignOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      }
    >
      {params.requested ? (
        <Alert tone="success">
          The gym will review your request. You can open this app once they
          approve it.
        </Alert>
      ) : (
        <p className="text-sm text-muted">
          This account isn&apos;t linked to a gym membership. Ask your gym for
          an invite, or open the join link they shared with you. If you asked to
          join, the gym still needs to approve it.
        </p>
      )}
    </AuthCard>
  );
}
