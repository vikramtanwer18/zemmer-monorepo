import { listPlatformAudit } from "@gym/core/platform";
import { DataTable, EmptyState, PageHeader, Pagination } from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Platform audit log" };

export default async function AuditPage({
  searchParams,
}: PageProps<"/audit-log">) {
  const { ctx } = await requireAdmin("/audit-log");
  if (!ctx.permissions.has("platform.audit.view")) {
    return (
      <EmptyState title="You don't have access to the platform audit log" />
    );
  }
  const params = await searchParams;
  const action =
    typeof params.action === "string" && params.action
      ? params.action
      : undefined;
  const page = Number(params.page) || 1;
  const log = await listPlatformAudit(services().deps, ctx, { action, page });
  const href = (p: number) =>
    `/audit-log?${new URLSearchParams({ ...(action ? { action } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Platform audit log"
        description="Every operator action, newest first."
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="action" className="text-sm font-medium">
            Action
          </label>
          <select
            id="action"
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
        caption="Platform audit log"
        rows={log.rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="Nothing logged yet" />}
        columns={[
          {
            key: "when",
            header: "When",
            cell: (r) =>
              r.createdAt.toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "medium",
                timeStyle: "short",
              }),
          },
          {
            key: "who",
            header: "Who",
            cell: (r) => r.actor?.email ?? "System",
          },
          {
            key: "action",
            header: "Action",
            cell: (r) => <code className="text-xs">{r.action}</code>,
          },
          {
            key: "tenant",
            header: "Tenant",
            hideOnMobile: true,
            cell: (r) =>
              r.tenantId ? (
                <a
                  className="text-primary underline"
                  href={`/tenants/${r.tenantId}`}
                >
                  View
                </a>
              ) : null,
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
