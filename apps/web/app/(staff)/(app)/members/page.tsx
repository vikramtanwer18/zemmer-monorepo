import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listMembers, memberName } from "@gym/core/members";
import { listPlans } from "@gym/core/plans";
import { Badge, EmptyState, LinkButton, PageHeader, Pagination } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { MemberTable } from "./member-table";

export const metadata: Metadata = { title: "Members" };

const STATE_TONE = {
  ACTIVE: "success",
  PAUSED: "info",
  PENDING_PAYMENT: "warning",
  EXPIRED: "neutral",
} as const;

export default async function MembersPage({
  searchParams,
}: PageProps<"/members">) {
  const { ctx, access } = await requireReady("/members");
  if (!hasPermission(ctx, "members.view")) return <NoAccess />;
  const sp = await searchParams;
  const filters = {
    q: str(sp.q),
    status: str(sp.status) ?? "ACTIVE",
    branchId: str(sp.branchId),
    planCode: str(sp.planCode),
    membership: str(sp.membership),
    expiringDays: str(sp.expiringDays),
    hasDues: str(sp.hasDues),
    sort: str(sp.sort) ?? "joinedAt",
    dir: str(sp.dir) ?? "desc",
    page: str(sp.page) ?? "1",
  };
  const { deps } = services();
  const [result, plans] = await Promise.all([
    listMembers(deps, ctx, filters),
    listPlans(deps, ctx),
  ]);
  const writable = isTenantWritable(ctx);
  const canCreate = writable && hasPermission(ctx, "members.create");
  const canEdit = writable && hasPermission(ctx, "members.edit");
  const query = (overrides: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...overrides }))
      if (v) p.set(k, v);
    return `/members?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Members"
        description={`${result.total} member${result.total === 1 ? "" : "s"}`}
        actions={
          <>
            {hasPermission(ctx, "members.delete") && (
              <LinkButton href="/members/privacy" variant="outline">
                Privacy requests
              </LinkButton>
            )}
            {(hasPermission(ctx, "members.import") ||
              hasPermission(ctx, "members.export")) && (
              <LinkButton href="/members/data" variant="outline">
                Import / export
              </LinkButton>
            )}
            {canCreate && (
              <LinkButton href="/members/new">Add member</LinkButton>
            )}
          </>
        }
      />
      <Flash params={sp} />
      <form
        method="get"
        className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7 lg:items-end"
      >
        <div className="col-span-2 flex flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={filters.q}
            placeholder="Name, code, phone or email"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
          />
        </div>
        <Select
          id="status"
          label="Record"
          value={filters.status}
          options={[
            ["ACTIVE", "Active"],
            ["PENDING_APPROVAL", "Awaiting approval"],
            ["ARCHIVED", "Archived"],
            ["all", "All"],
          ]}
        />
        <Select
          id="membership"
          label="Membership"
          value={filters.membership ?? ""}
          options={[
            ["", "Any"],
            ["active", "Active"],
            ["paused", "Frozen"],
            ["pending", "Awaiting payment"],
            ["expired", "Expired"],
            ["none", "Never bought"],
          ]}
        />
        <Select
          id="branchId"
          label="Branch"
          value={filters.branchId ?? ""}
          options={[
            ["", "All"],
            ...access.branches.map((b) => [b.id, b.name] as [string, string]),
          ]}
        />
        <Select
          id="planCode"
          label="Plan"
          value={filters.planCode ?? ""}
          options={[
            ["", "Any"],
            ...plans.map((p) => [p.code, p.name] as [string, string]),
          ]}
        />
        <Select
          id="expiringDays"
          label="Expiring within"
          value={filters.expiringDays ?? ""}
          options={[
            ["", "Any time"],
            ["7", "7 days"],
            ["14", "14 days"],
            ["30", "30 days"],
          ]}
        />
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="hasDues"
            value="1"
            defaultChecked={!!filters.hasDues}
            className="size-4 accent-primary"
          />
          Has dues
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Filter
          </button>
          <a
            href="/members"
            className="flex h-10 items-center rounded-md px-3 text-sm text-muted hover:text-foreground"
          >
            Reset
          </a>
        </div>
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          title="No members match"
          description={
            filters.q || filters.membership
              ? "Try fewer filters."
              : "Add your first member to get started."
          }
          action={
            canCreate ? (
              <LinkButton href="/members/new">Add member</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <MemberTable
          canEdit={canEdit}
          back={query({})}
          branches={access.branches.map((b) => ({ id: b.id, name: b.name }))}
          sortHref={{
            name: query({
              sort: "name",
              dir:
                filters.sort === "name" && filters.dir === "asc"
                  ? "desc"
                  : "asc",
              page: "1",
            }),
            joinedAt: query({
              sort: "joinedAt",
              dir:
                filters.sort === "joinedAt" && filters.dir === "desc"
                  ? "asc"
                  : "desc",
              page: "1",
            }),
          }}
          sort={{ key: filters.sort, dir: filters.dir }}
          rows={result.rows.map((m) => {
            const latest = m.memberships[0];
            return {
              id: m.id,
              name: memberName(m),
              code: m.memberCode,
              contact: m.phone ?? m.email ?? "",
              branch: m.homeBranch.name,
              joined: day(m.joinedAt),
              status: m.status,
              tags: m.tags,
              membership: latest
                ? {
                    label: `${latest.plan.name} · until ${day(latest.endDate)}`,
                    state: latest.status,
                    tone:
                      STATE_TONE[latest.status as keyof typeof STATE_TONE] ??
                      "neutral",
                  }
                : null,
            };
          })}
        />
      )}
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        hrefFor={(p) => query({ page: String(p) })}
      />
      {result.rows.some((r) => r.status === "PENDING_APPROVAL") && (
        <p className="mt-3 text-sm text-muted">
          <Badge tone="warning">Awaiting approval</Badge> members joined through
          your join link; open them to approve.
        </p>
      )}
    </>
  );
}

function Select({
  id,
  label,
  value,
  options,
}: {
  id: string;
  label: string;
  value: string;
  options: [string, string][];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        name={id}
        defaultValue={value}
        className="h-10 rounded-md border border-border bg-surface px-2 text-sm"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
