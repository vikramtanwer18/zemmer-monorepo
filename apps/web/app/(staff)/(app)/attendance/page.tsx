import { listAttendance } from "@gym/core/attendance";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { todayIn } from "@gym/core/time/dates";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { correctAttendanceAction } from "./actions";

export const metadata: Metadata = { title: "Check-ins" };

export default async function AttendancePage({
  searchParams,
}: PageProps<"/attendance">) {
  const { ctx, access, session } = await requireReady("/attendance");
  if (!hasPermission(ctx, "attendance.view")) return <NoAccess />;
  const sp = await searchParams;
  const branchId = str(sp.branchId) ?? session.activeBranchId ?? undefined;
  const date = str(sp.date) ?? todayIn(ctx.timezone);
  const result = str(sp.result) ?? "all";
  const page = Number(str(sp.page) ?? 1) || 1;
  const data = await listAttendance(services().deps, ctx, {
    branchId,
    date,
    result,
    page,
  });
  const canCorrect =
    isTenantWritable(ctx) && hasPermission(ctx, "attendance.correct");
  const query = new URLSearchParams({
    ...(branchId ? { branchId } : {}),
    date,
    result,
  });
  const back = `/attendance?${query}`;
  const time = (d: Date) =>
    d.toLocaleTimeString("en-IN", {
      timeZone: ctx.timezone,
      timeStyle: "short",
    });

  return (
    <>
      <PageHeader
        title="Check-ins"
        description={`${date}${branchId ? ` · ${access.branches.find((b) => b.id === branchId)?.name ?? ""}` : " · all branches"}`}
        actions={
          hasPermission(ctx, "attendance.scan") && (
            <LinkButton href="/scan">Scan</LinkButton>
          )
        }
      />
      <Flash params={sp} />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Date
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="h-10 rounded-md border border-border bg-surface px-3"
          />
        </label>
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
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Show
          <select
            name="result"
            defaultValue={result}
            className="h-10 rounded-md border border-border bg-surface px-2"
          >
            <option value="all">Everything</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="REJECTED">Refused</option>
          </select>
        </label>
        <button
          type="submit"
          className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-background"
        >
          Update
        </button>
      </form>
      <section
        aria-label="Summary"
        className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <StatCard label="Check-ins" value={data.summary.checkIns} />
        <StatCard label="Members" value={data.summary.uniqueMembers} />
        {data.summary.currentlyIn !== null && (
          <StatCard label="In the gym now" value={data.summary.currentlyIn} />
        )}
        <StatCard
          label="Refused scans"
          value={data.summary.rejected}
          tone={data.summary.rejected > 0 ? "warning" : "default"}
        />
      </section>
      <DataTable
        caption="Check-ins"
        rows={data.rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No check-ins"
            description="Scans and manual check-ins for this day appear here."
          />
        }
        columns={[
          {
            key: "time",
            header: "Time",
            cell: (r) => (
              <span className={r.voided ? "line-through text-muted" : ""}>
                {time(r.occurredAt)}
                {r.corrected ? " (corrected)" : ""}
              </span>
            ),
          },
          {
            key: "member",
            header: "Member",
            cell: (r) =>
              r.member ? (
                hasPermission(ctx, "members.view") ? (
                  <a
                    className="font-medium text-primary underline"
                    href={`/members/${r.member.id}`}
                  >
                    {r.member.name}
                  </a>
                ) : (
                  r.member.name
                )
              ) : (
                <span className="text-muted">Unknown pass</span>
              ),
          },
          {
            key: "result",
            header: "Result",
            cell: (r) =>
              r.voided ? (
                <Badge>Removed: {r.voidReason}</Badge>
              ) : r.result === "ACCEPTED" ? (
                <Badge tone={r.overridden ? "warning" : "success"}>
                  {r.type === "CHECK_OUT" ? "Out" : "In"}
                  {r.overridden ? " (override)" : ""}
                </Badge>
              ) : (
                <span className="flex flex-col">
                  <Badge tone="danger">Refused</Badge>
                  <span className="text-xs text-muted">{r.rejectMessage}</span>
                </span>
              ),
          },
          {
            key: "how",
            header: "How",
            hideOnMobile: true,
            cell: (r) => (
              <span className="text-sm">
                {r.method === "QR" ? "QR scan" : "By hand"}
                {r.reason ? ` · ${r.reason}` : ""}
                <span className="block text-xs text-muted">
                  {[r.staff, r.device, r.branch].filter(Boolean).join(" · ")}
                </span>
              </span>
            ),
          },
          ...(canCorrect
            ? [
                {
                  key: "fix",
                  header: "Correct",
                  cell: (r: (typeof data.rows)[number]) =>
                    r.result === "ACCEPTED" && !r.voided ? (
                      <div className="flex flex-wrap gap-1">
                        <ConfirmDialog
                          trigger="Change time"
                          title="Change the check-in time"
                          confirmLabel="Save"
                          confirmVariant="primary"
                          formAction={correctAttendanceAction}
                          fields={{ eventId: r.id, action: "retime", back }}
                        >
                          <label className="flex flex-col gap-1.5 text-sm font-medium">
                            New time (same day)
                            <input
                              type="time"
                              name="time"
                              required
                              className="h-10 rounded-md border border-border bg-surface px-3"
                            />
                          </label>
                          <label className="mt-3 flex flex-col gap-1.5 text-sm font-medium">
                            Reason
                            <input
                              name="reason"
                              required
                              minLength={3}
                              className="h-10 rounded-md border border-border bg-surface px-3"
                            />
                          </label>
                        </ConfirmDialog>
                        <ConfirmDialog
                          trigger="Remove"
                          title="Remove this check-in?"
                          description="It stays in the history as removed, with your reason."
                          confirmLabel="Remove"
                          formAction={correctAttendanceAction}
                          fields={{ eventId: r.id, action: "void", back }}
                        >
                          <label className="flex flex-col gap-1.5 text-sm font-medium">
                            Reason
                            <input
                              name="reason"
                              required
                              minLength={3}
                              className="h-10 rounded-md border border-border bg-surface px-3"
                            />
                          </label>
                        </ConfirmDialog>
                      </div>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        hrefFor={(p) => `/attendance?${query}&page=${p}`}
      />
    </>
  );
}
