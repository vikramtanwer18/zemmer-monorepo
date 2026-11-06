import { listMySupportSessions } from "@gym/core/platform";
import { Alert, Badge, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Support sessions" };

export default async function SupportPage({
  searchParams,
}: PageProps<"/support">) {
  const { ctx } = await requireAdmin("/support");
  if (!ctx.permissions.has("platform.support.access")) {
    return <EmptyState title="You don't have support access" />;
  }
  const sessions = await listMySupportSessions(services().deps, ctx);
  const now = new Date();
  const sp = await searchParams;

  return (
    <>
      <PageHeader
        title="Support sessions"
        description="Open one from a tenant's page. They end on their own after the time you chose."
      />
      {typeof sp.notice === "string" && (
        <Alert tone="success" className="mb-4">
          {sp.notice}
        </Alert>
      )}
      {typeof sp.error === "string" && (
        <Alert tone="danger" className="mb-4">
          {sp.error}
        </Alert>
      )}
      <DataTable
        caption="My support sessions"
        rows={sessions}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No support sessions yet" />}
        columns={[
          {
            key: "tenant",
            header: "Tenant",
            cell: (s) => {
              const live = !s.endedAt && s.expiresAt > now;
              return live ? (
                <a
                  className="font-medium text-primary underline"
                  href={`/support/${s.id}`}
                >
                  {s.tenant.displayName}
                </a>
              ) : (
                s.tenant.displayName
              );
            },
          },
          { key: "reason", header: "Reason", cell: (s) => s.reason },
          {
            key: "state",
            header: "State",
            cell: (s) =>
              s.endedAt ? (
                <Badge>ended</Badge>
              ) : s.expiresAt <= now ? (
                <Badge>expired</Badge>
              ) : (
                <Badge tone="warning">open</Badge>
              ),
          },
          {
            key: "until",
            header: "Until",
            hideOnMobile: true,
            cell: (s) =>
              s.expiresAt.toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "medium",
                timeStyle: "short",
              }),
          },
        ]}
      />
    </>
  );
}
