import { hasPermission } from "@gym/core/authz";
import { isFeatureEnabled } from "@gym/core/entitlements";
import { searchMembersForFitness } from "@gym/core/fitness";
import { listMyClients } from "@gym/core/staff";
import { entitlementsFor } from "@gym/core/tenancy";
import { Badge, Button, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { FitnessTabs } from "./fitness-tabs";

export const metadata: Metadata = { title: "Fitness" };

export default async function FitnessPage({
  searchParams,
}: PageProps<"/fitness">) {
  const { ctx } = await requireReady("/fitness");
  if (
    !hasPermission(ctx, "fitness.manage") &&
    !hasPermission(ctx, "fitness.view_all")
  )
    return <NoAccess />;
  const { deps } = services();
  const ent = await entitlementsFor(deps, ctx.tenantId);
  if (!isFeatureEnabled(ent, "workouts.enabled"))
    return <UpgradeNotice title="Fitness" feature="Workout programs" />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const viewAll = hasPermission(ctx, "fitness.view_all");
  const clients = hasPermission(ctx, "clients.view")
    ? await listMyClients(deps, ctx)
    : null;
  const found = viewAll && q ? await searchMembersForFitness(deps, ctx, q) : [];
  return (
    <>
      <PageHeader
        title="Fitness"
        description="Plans, workouts, assessments and diet plans. You see the members assigned to you; owners and admins can open anyone who agreed to fitness tracking."
      />
      <FitnessTabs
        current="/fitness"
        nutrition={isFeatureEnabled(ent, "nutrition.enabled")}
      />
      <Flash params={sp} />
      {clients?.trainer && (
        <section className="mb-6">
          <h2 className="mb-2 text-base font-semibold">My clients</h2>
          <DataTable
            caption="My clients"
            rows={clients.clients}
            rowKey={(c) => c.memberId}
            empty={
              <EmptyState
                title="No clients assigned"
                description="A manager assigns members to you on the member's page."
              />
            }
            columns={[
              {
                key: "name",
                header: "Member",
                cell: (c) => (
                  <a
                    className="font-medium text-primary underline"
                    href={`/fitness/members/${c.memberId}`}
                  >
                    {c.name}
                  </a>
                ),
              },
              {
                key: "code",
                header: "No.",
                hideOnMobile: true,
                cell: (c) => c.memberCode,
              },
              {
                key: "m",
                header: "Membership",
                cell: (c) =>
                  c.membership
                    ? `${c.membership.plan} · ${c.membership.daysLeft} d left`
                    : "—",
              },
            ]}
          />
        </section>
      )}
      {viewAll && (
        <section>
          <form method="get" className="mb-3 flex max-w-md gap-2">
            <input
              name="q"
              defaultValue={q}
              placeholder="Find a member by name or number"
              aria-label="Find a member"
              className="h-10 flex-1 rounded-md border border-border bg-surface px-3"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {q && (
            <DataTable
              caption="Members"
              rows={found}
              rowKey={(m) => m.id}
              empty={<EmptyState title="Nobody found" />}
              columns={[
                {
                  key: "name",
                  header: "Member",
                  cell: (m) => (
                    <a
                      className="font-medium text-primary underline"
                      href={`/fitness/members/${m.id}`}
                    >
                      {[m.firstName, m.lastName].filter(Boolean).join(" ")}
                    </a>
                  ),
                },
                { key: "code", header: "No.", cell: (m) => m.memberCode },
                {
                  key: "consent",
                  header: "Fitness tracking",
                  cell: (m) => (
                    <Badge tone={m.consent ? "success" : "neutral"}>
                      {m.consent ? "Agreed" : "Not agreed"}
                    </Badge>
                  ),
                },
              ]}
            />
          )}
        </section>
      )}
    </>
  );
}
