import { listAuditLogs } from "@gym/core/audit";
import { hasPermission } from "@gym/core/authz";
import { Badge, DataTable, EmptyState, PageHeader, Pagination } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditLogPage({
  searchParams,
}: PageProps<"/audit-log">) {
  const { ctx } = await requireReady("/audit-log");
  if (!hasPermission(ctx, "audit.view")) return <NoAccess />;
  const params = await searchParams;
  const action =
    typeof params.action === "string" && params.action
      ? params.action
      : undefined;
  const page = Number(params.page) || 1;
  const log = await listAuditLogs(services().deps.db, ctx, { action, page });
  const tz = ctx.timezone;
  const href = (p: number) =>
    `/audit-log?${new URLSearchParams({ ...(action ? { action } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sensitive changes in this gym, newest first."
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="action-filter" className="text-sm font-medium">
            Action
          </label>
          <select
            id="action-filter"
            name="action"
            defaultValue={action ?? ""}
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          >
            <option value="">All actions</option>
            {log.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-background"
        >
          Filter
        </button>
      </form>
      <DataTable
        caption="Audit log"
        rows={log.rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="Nothing logged yet" />}
        columns={[
          {
            key: "when",
            header: "When",
            cell: (r) =>
              r.createdAt.toLocaleString("en-IN", {
                timeZone: tz,
                dateStyle: "medium",
                timeStyle: "short",
              }),
          },
          {
            key: "who",
            header: "Who",
            cell: (r) =>
              r.actorType === "PLATFORM" ? (
                <Badge tone="warning">Platform</Badge>
              ) : r.actorType === "SYSTEM" ? (
                <Badge tone="neutral">System</Badge>
              ) : (
                (r.actor?.name ?? "Unknown user")
              ),
          },
          {
            key: "action",
            header: "Action",
            cell: (r) => <code className="text-xs">{r.action}</code>,
          },
          {
            key: "details",
            header: "Details",
            hideOnMobile: true,
            cell: (r) => {
              const detail = r.meta ?? r.after;
              return detail ? (
                <code
                  className="block max-w-md truncate text-xs text-muted"
                  title={JSON.stringify(detail)}
                >
                  {JSON.stringify(detail)}
                </code>
              ) : null;
            },
          },
        ]}
      />
      <Pagination
        page={log.page}
        pageSize={log.pageSize}
        total={log.total}
        hrefFor={href}
      />
    </>
  );
}
