import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listPtAppointments } from "@gym/core/staff";
import { addDays, todayIn } from "@gym/core/time/dates";
import { LinkButton, PageHeader, Tabs } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { AppointmentList } from "./appointment-list";

export const metadata: Metadata = { title: "Personal training" };

export default async function PtPage({ searchParams }: PageProps<"/pt">) {
  const { ctx } = await requireReady("/pt");
  if (!hasPermission(ctx, "pt.manage") && !hasPermission(ctx, "pt.own"))
    return <NoAccess />;
  const sp = await searchParams;
  const from = str(sp.from) ?? todayIn(ctx.timezone);
  const data = await listPtAppointments(services().deps, ctx, {
    from,
    days: 7,
  });
  const back = `/pt?from=${from}`;
  return (
    <>
      <PageHeader
        title="Personal training"
        description={`Sessions from ${from} for 7 days. Sell packages and book sessions from a member's page.`}
        actions={
          hasPermission(ctx, "plans.manage") && (
            <LinkButton href="/pt/packages" variant="outline">
              Packages
            </LinkButton>
          )
        }
      />
      <Tabs
        label="Personal training sections"
        current="/pt"
        items={[
          { href: "/pt", label: "Sessions" },
          ...(hasPermission(ctx, "memberships.view")
            ? [{ href: "/pt/packages", label: "Packages" }]
            : []),
        ]}
      />
      <Flash params={sp} />
      <div className="mb-4 flex gap-2 text-sm">
        <a
          className="rounded-md border border-border bg-surface px-3 py-1.5"
          href={`/pt?from=${addDays(from, -7)}`}
        >
          ← Previous
        </a>
        <a
          className="rounded-md border border-border bg-surface px-3 py-1.5"
          href="/pt"
        >
          Today
        </a>
        <a
          className="rounded-md border border-border bg-surface px-3 py-1.5"
          href={`/pt?from=${addDays(from, 7)}`}
        >
          Next →
        </a>
      </div>
      <AppointmentList
        rows={data.appointments}
        back={back}
        canAct={isTenantWritable(ctx)}
        linkMembers={hasPermission(ctx, "members.view")}
      />
    </>
  );
}
