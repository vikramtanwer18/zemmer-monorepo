import { listMyTenants } from "@gym/core/tenancy";
import { AuthCard, Badge, Button } from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { services } from "@/lib/services";
import { getSessionState } from "@/lib/session";
import { selectTenantAction, signOutAction } from "../actions";

export const metadata: Metadata = { title: "Choose a gym" };

const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "Awaiting approval",
  SUSPENDED: "Suspended",
};

export default async function SelectTenantPage() {
  const state = await getSessionState();
  if (state.kind === "anonymous" || state.kind === "deactivated")
    redirect("/sign-in");
  const tenants = await listMyTenants(services().db, state.user.id);
  const activeId = state.session.activeTenantId;

  return (
    <AuthCard
      brand={services().brand}
      title="Choose a gym"
      description={`Signed in as ${state.user.email}`}
      footer={
        <div className="flex items-center justify-center gap-4">
          <a className="text-primary underline" href="/onboarding">
            Set up a new gym
          </a>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      }
    >
      {tenants.length === 0 ? (
        <p className="text-sm text-muted">
          You aren&apos;t part of any gym yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tenants.map((tenant) => (
            <li key={tenant.tenantId}>
              <form action={selectTenantAction}>
                <input type="hidden" name="tenantId" value={tenant.tenantId} />
                <button
                  type="submit"
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-4 py-3 text-left hover:bg-background"
                >
                  <span className="font-medium">{tenant.displayName}</span>
                  <span className="flex gap-2">
                    {tenant.tenantId === activeId && (
                      <Badge tone="info">Current</Badge>
                    )}
                    {STATUS_LABEL[tenant.status] && (
                      <Badge tone="warning">
                        {STATUS_LABEL[tenant.status]}
                      </Badge>
                    )}
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  );
}
