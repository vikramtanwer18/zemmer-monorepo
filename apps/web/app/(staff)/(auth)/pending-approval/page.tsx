import { AuthCard, Button } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";
import { signOutAction } from "../actions";

export const metadata: Metadata = { title: "Awaiting approval" };

export default async function PendingApprovalPage() {
  const state = await getSessionState();
  if (state.kind !== "pending-approval") redirect("/");
  return (
    <AuthCard
      brand={services().brand}
      title="We're reviewing your gym"
      description={`Thanks for signing up ${state.access.tenant.displayName}. We'll email ${state.user.email} as soon as it's approved; your free trial starts then.`}
      footer={
        <div className="flex items-center justify-center gap-4">
          <a className="text-primary underline" href="/select-tenant">
            Switch gym
          </a>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      }
    >
      <a href="/pending-approval" className="text-sm text-primary underline">
        Check again
      </a>
    </AuthCard>
  );
}
