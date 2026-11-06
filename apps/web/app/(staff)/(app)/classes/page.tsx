import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listClassSessions } from "@gym/core/classes";
import { addDays, isoWeekday, todayIn } from "@gym/core/time/dates";
import { Badge, EmptyState, LinkButton, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { ClassesTabs } from "./classes-tabs";

export const metadata: Metadata = { title: "Classes" };

const fmt = (date: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    ...opts,
  });

export default async function ClassesPage({
  searchParams,
}: PageProps<"/classes">) {
  const { ctx, access, session } = await requireReady("/classes");
  if (!hasPermission(ctx, "classes.view")) return <NoAccess />;
  const sp = await searchParams;
  const view = str(sp.view) === "day" ? "day" : "week";
  const today = todayIn(ctx.timezone);
  const anchor = str(sp.from) ?? today;
  // Weeks start on Monday.
  const from =
    view === "week" ? addDays(anchor, 1 - isoWeekday(anchor)) : anchor;
  const days = view === "week" ? 7 : 1;
  const branchId = str(sp.branchId) ?? session.activeBranchId ?? undefined;
  const data = await listClassSessions(services().deps, ctx, {
    from,
    days,
    branchId,
  });
  const canManage =
    isTenantWritable(ctx) && hasPermission(ctx, "classes.manage");
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const link = (f: string, v = view) =>
    `/classes?${new URLSearchParams({ from: f, view: v, ...(branchId ? { branchId } : {}) })}`;

  return (
    <>
      <PageHeader
        title="Classes"
        description={
          view === "week"
            ? `Week of ${fmt(from, { day: "numeric", month: "short", year: "numeric" })}`
            : fmt(from, { weekday: "long", day: "numeric", month: "long" })
        }
        actions={
          canManage && (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/classes/templates/new" variant="outline">
                Recurring class
              </LinkButton>
              <LinkButton href="/classes/sessions/new">
                One-off class
              </LinkButton>
            </div>
          )
        }
      />
      <ClassesTabs current="/classes" />
      <Flash params={sp} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <a
            className="rounded-md border border-border bg-surface px-3 py-1.5"
            href={link(addDays(from, -days))}
          >
            ← {view === "week" ? "Previous week" : "Previous day"}
          </a>
          <a
            className="rounded-md border border-border bg-surface px-3 py-1.5"
            href={link(today)}
          >
            Today
          </a>
          <a
            className="rounded-md border border-border bg-surface px-3 py-1.5"
            href={link(addDays(from, days))}
          >
            {view === "week" ? "Next week" : "Next day"} →
          </a>
          <a
            className="rounded-md px-3 py-1.5 text-primary underline"
            href={link(
              view === "week" ? today : from,
              view === "week" ? "day" : "week",
            )}
          >
            {view === "week" ? "Day view" : "Week view"}
          </a>
        </div>
        <form method="get" className="flex items-end gap-2">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="view" value={view} />
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Branch
            <select
              name="branchId"
              defaultValue={branchId ?? ""}
              className="h-10 rounded-md border border-border bg-surface px-2"
            >
              <option value="">All my branches</option>
              {access.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium"
          >
            Show
          </button>
        </form>
      </div>
      {data.sessions.length === 0 ? (
        <EmptyState
          title="No classes in this period"
          description={
            canManage
              ? "Add a recurring class (e.g. Yoga every Mon/Wed at 06:30) or a one-off class."
              : "Nothing scheduled."
          }
          action={
            canManage ? (
              <LinkButton href="/classes/templates/new">
                Add a recurring class
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <div
          className={`grid grid-cols-1 gap-3 ${view === "week" ? "md:grid-cols-7" : ""}`}
        >
          {dates.map((d) => {
            const items = data.sessions.filter((s) => s.date === d);
            return (
              <section
                key={d}
                aria-label={fmt(d, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
                className={`flex min-w-0 flex-col gap-2 rounded-lg border p-2 ${d === today ? "border-primary" : "border-border"}`}
              >
                <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                  {fmt(d, { weekday: "short", day: "numeric", month: "short" })}
                </h2>
                {items.length === 0 && (
                  <p className="px-1 text-xs text-muted">—</p>
                )}
                {items.map((s) => (
                  <a
                    key={s.id}
                    href={`/classes/${s.id}`}
                    className={`flex flex-col gap-0.5 rounded-md border-l-4 bg-surface p-2 text-sm shadow-sm hover:bg-background ${s.status === "CANCELLED" ? "opacity-60" : ""}`}
                    style={{ borderLeftColor: s.category?.color ?? "#204289" }}
                  >
                    <span className="font-medium">
                      {s.startTime} {s.name}
                    </span>
                    <span className="text-xs text-muted">
                      {s.bookedCount}/{s.capacity}
                      {s.waitlist ? ` · ${s.waitlist} waiting` : ""}
                      {s.trainer ? ` · ${s.trainer}` : ""}
                      {s.room ? ` · ${s.room}` : ""}
                    </span>
                    {s.status === "CANCELLED" && (
                      <Badge tone="danger">Cancelled</Badge>
                    )}
                    {s.conflictNote && s.status === "SCHEDULED" && (
                      <Badge tone="warning">Check</Badge>
                    )}
                  </a>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
