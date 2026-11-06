import { listTenants } from "@gym/core/platform";
import {
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { StatusBadge } from "./status-badge";

export const metadata: Metadata = { title: "Tenants" };

const STATUSES = [
  "PENDING_APPROVAL",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
] as const;

export default async function TenantsPage({
  searchParams,
}: PageProps<"/tenants">) {
  const { ctx } = await requireAdmin("/tenants");
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const status =
    typeof params.status === "string" &&
    (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : "";
  const page = Number(params.page) || 1;
  const result = await listTenants(services().deps, ctx, {
    q: q || undefined,
    status: status || undefined,
    page,
  });
  const href = (p: number) =>
    `/tenants?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Tenants"
        actions={
          ctx.permissions.has("platform.tenants.manage") && (
            <LinkButton href="/tenants/new">Create tenant</LinkButton>
          )
        }
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Name or slug"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-sm font-medium">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ").toLowerCase()}
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
        caption="Tenants"
        rows={result.rows}
        rowKey={(t) => t.id}
        empty={<EmptyState title="No tenants match" />}
        columns={[
          {
            key: "name",
            header: "Tenant",
            cell: (t) => (
              <div className="flex flex-col">
                <a
                  className="font-medium text-primary underline"
                  href={`/tenants/${t.id}`}
                >
                  {t.displayName}
                </a>
                <span className="text-xs text-muted">{t.slug}</span>
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (t) => <StatusBadge status={t.status} />,
          },
          {
            key: "plan",
            header: "Plan",
            hideOnMobile: true,
            cell: (t) =>
              t.subscription ? (
                <span className="flex items-center gap-2">
                  {t.subscription.plan.name} v{t.subscription.plan.version}
                  <Badge
                    tone={
                      t.subscription.status === "SUSPENDED"
                        ? "danger"
                        : "neutral"
                    }
                  >
                    {t.subscription.status.toLowerCase()}
                  </Badge>
                </span>
              ) : (
                "—"
              ),
          },
          {
            key: "created",
            header: "Created",
            hideOnMobile: true,
            cell: (t) =>
              t.createdAt.toLocaleDateString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "medium",
              }),
          },
        ]}
      />
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        hrefFor={href}
      />
    </>
  );
}
