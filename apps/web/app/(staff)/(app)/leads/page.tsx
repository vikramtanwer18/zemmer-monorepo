import { hasPermission } from "@gym/core/authz";
import {
  getCrmSetup,
  listLeads,
  listSavedViews,
  crmStaffOptions,
} from "@gym/core/crm";
import { startOfDayUtc } from "@gym/core/time/dates";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { deleteViewAction, exportLeadsAction, saveViewAction } from "./actions";
import { CATEGORY_TONE, LeadsTabs } from "./leads-tabs";

export const metadata: Metadata = { title: "Leads" };

const FILTER_KEYS = [
  "q",
  "status",
  "stageId",
  "category",
  "owner",
  "sourceId",
  "campaignId",
  "branchId",
  "from",
  "to",
  "overdue",
  "sort",
] as const;

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const { ctx, access } = await requireReady("/leads");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const filters = Object.fromEntries(
    FILTER_KEYS.map((k) => [k, str(sp[k])]).filter(
      ([, v]) => v !== undefined && v !== "",
    ),
  ) as Record<string, string>;
  const deps = services().deps;
  const range = {
    from: filters.from ? startOfDayUtc(filters.from, ctx.timezone) : undefined,
    to: filters.to ? startOfDayUtc(filters.to, ctx.timezone) : undefined,
  };
  const result = await orUpgrade(
    listLeads(deps, ctx, { ...filters, page: str(sp.page) ?? "1" }, range),
  );
  if (!result) return <UpgradeNotice title="Leads" feature="Leads and CRM" />;
  const [setup, views, staff] = [
    await getCrmSetup(deps, ctx),
    await listSavedViews(deps, ctx),
    await crmStaffOptions(deps, ctx, null),
  ];
  const query = new URLSearchParams(filters).toString();
  const href = (p: number) =>
    `/leads?${new URLSearchParams({ ...filters, page: String(p) })}`;
  const select = "h-10 rounded-md border border-border bg-surface px-2 text-sm";
  return (
    <>
      <PageHeader
        title="Leads"
        description={`${result.total} lead${result.total === 1 ? "" : "s"}`}
        actions={
          hasPermission(ctx, "leads.manage") ? (
            <LinkButton href="/leads/new">Add lead</LinkButton>
          ) : undefined
        }
      />
      <LeadsTabs current="/leads" />
      <Flash params={sp} />

      {views.length > 0 && (
        <nav
          aria-label="Saved views"
          className="mb-3 flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted">Views:</span>
          {views.map((v) => {
            const q = new URLSearchParams(
              Object.entries(v.filters as Record<string, unknown>)
                .filter(
                  ([, val]) =>
                    val !== undefined &&
                    val !== null &&
                    val !== "" &&
                    val !== false,
                )
                .map(([k, val]) => [k, val === true ? "on" : String(val)]),
            ).toString();
            return (
              <span
                key={v.id}
                className="flex items-center gap-1 rounded-full border border-border px-3 py-1"
              >
                <a href={`/leads?${q}`} className="font-medium text-primary">
                  {v.name}
                </a>
                {v.shared && <Badge tone="neutral">team</Badge>}
                {v.userId === ctx.userId && (
                  <form action={deleteViewAction}>
                    <input type="hidden" name="viewId" value={v.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted hover:text-danger"
                      aria-label={`Remove view ${v.name}`}
                    >
                      ×
                    </button>
                  </form>
                )}
              </span>
            );
          })}
        </nav>
      )}

      <form
        method="get"
        className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6 lg:items-end"
      >
        <label className="col-span-2 flex flex-col gap-1.5 text-sm font-medium">
          Search
          <input
            name="q"
            defaultValue={filters.q}
            placeholder="Name, mobile or email"
            className="h-10 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Status
          <select
            name="status"
            defaultValue={filters.status ?? "OPEN"}
            className={select}
          >
            <option value="OPEN">Open</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
            <option value="ALL">All</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Stage
          <select
            name="stageId"
            defaultValue={filters.stageId ?? ""}
            className={select}
          >
            <option value="">Any</option>
            {setup.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Owner
          <select
            name="owner"
            defaultValue={filters.owner ?? ""}
            className={select}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Nobody yet</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Source
          <select
            name="sourceId"
            defaultValue={filters.sourceId ?? ""}
            className={select}
          >
            <option value="">Any</option>
            {setup.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Campaign
          <select
            name="campaignId"
            defaultValue={filters.campaignId ?? ""}
            className={select}
          >
            <option value="">Any</option>
            {setup.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {access.branches.length > 1 && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Branch
            <select
              name="branchId"
              defaultValue={filters.branchId ?? ""}
              className={select}
            >
              <option value="">All</option>
              {access.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Added from
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            className={select}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Added before
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            className={select}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Sort
          <select
            name="sort"
            defaultValue={filters.sort ?? "newest"}
            className={select}
          >
            <option value="newest">Newest</option>
            <option value="score">Score</option>
            <option value="updated">Recently changed</option>
            <option value="oldest">Oldest</option>
          </select>
        </label>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="overdue"
            value="on"
            defaultChecked={filters.overdue === "on"}
            className="size-4"
          />
          Overdue task
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="outline">
            Filter
          </Button>
          <a
            href="/leads"
            className="flex h-10 items-center px-2 text-sm text-primary underline"
          >
            Clear
          </a>
        </div>
      </form>

      <DataTable
        caption="Leads"
        rows={result.rows}
        rowKey={(l) => l.id}
        empty={
          <EmptyState
            title={query ? "No leads match" : "No leads yet"}
            description={
              query
                ? "Try other filters."
                : "Add one, or share a capture form from Settings → Leads."
            }
            action={
              hasPermission(ctx, "leads.manage") ? (
                <LinkButton href="/leads/new">Add lead</LinkButton>
              ) : undefined
            }
          />
        }
        columns={[
          {
            key: "name",
            header: "Lead",
            cell: (l) => (
              <a
                href={`/leads/${l.id}`}
                className="font-medium text-primary underline"
              >
                {l.name}
                <span className="block text-xs font-normal text-muted">
                  {l.phone ?? l.email}
                </span>
              </a>
            ),
          },
          {
            key: "stage",
            header: "Stage",
            cell: (l) => (
              <Badge tone={CATEGORY_TONE[l.stage.category]}>
                {l.stage.name}
              </Badge>
            ),
          },
          { key: "score", header: "Score", cell: (l) => l.score },
          {
            key: "next",
            header: "Next task",
            hideOnMobile: true,
            cell: (l) =>
              l.nextTask ? (
                <span
                  className={`text-sm ${l.nextTask.overdue ? "font-medium text-danger" : ""}`}
                >
                  {l.nextTask.overdue ? "Overdue: " : ""}
                  {when(l.nextTask.dueAt, ctx.timezone)}
                </span>
              ) : (
                <span className="text-sm text-muted">—</span>
              ),
          },
          {
            key: "owner",
            header: "Owner",
            hideOnMobile: true,
            cell: (l) => l.owner ?? <span className="text-muted">Nobody</span>,
          },
          {
            key: "source",
            header: "Source",
            hideOnMobile: true,
            cell: (l) =>
              [l.source, l.campaign].filter(Boolean).join(" · ") || "—",
          },
          {
            key: "added",
            header: "Added",
            hideOnMobile: true,
            cell: (l) => when(l.createdAt, ctx.timezone),
          },
        ]}
      />
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        hrefFor={href}
      />

      <div className="mt-6 flex flex-wrap items-end gap-6 border-t border-border pt-4">
        <form
          action={saveViewAction}
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="query" value={query} />
          <input type="hidden" name="back" value={`/leads?${query}`} />
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Save these filters as a view
            <input
              name="name"
              required
              minLength={2}
              maxLength={40}
              placeholder="e.g. My hot leads"
              className="h-10 rounded-md border border-border bg-surface px-3"
            />
          </label>
          {hasPermission(ctx, "leads.assign") && (
            <label className="flex h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="shared"
                value="on"
                className="size-4"
              />{" "}
              For the whole team
            </label>
          )}
          <Button type="submit" variant="outline">
            Save view
          </Button>
        </form>
        {hasPermission(ctx, "leads.export") && (
          <form action={exportLeadsAction}>
            <input type="hidden" name="query" value={query} />
            <Button type="submit" variant="ghost">
              Export these leads (CSV)
            </Button>
          </form>
        )}
      </div>
    </>
  );
}
