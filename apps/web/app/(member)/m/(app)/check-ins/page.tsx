import { getMyCheckIns } from "@gym/core/attendance";
import { Card, EmptyState } from "@gym/ui";
import { Flame } from "lucide-react";
import type { Metadata } from "next";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Check-ins" };

export default async function MyCheckInsPage() {
  const { mctx } = await requireMember("/m/check-ins");
  const data = await getMyCheckIns(services().deps, mctx, { limit: 50 });
  return (
    <>
      <h1 className="text-xl font-semibold">Check-ins</h1>
      <div className="grid grid-cols-2 gap-3">
        <Card className="flex flex-col gap-1 p-4">
          <span className="flex items-center gap-1 text-sm text-muted">
            <Flame aria-hidden="true" className="size-4 text-accent" /> Streak
          </span>
          <span className="text-2xl font-semibold" data-testid="streak">
            {data.streakDays} day{data.streakDays === 1 ? "" : "s"}
          </span>
        </Card>
        <Card className="flex flex-col gap-1 p-4">
          <span className="text-sm text-muted">Last 7 days</span>
          <span className="text-2xl font-semibold">
            {data.visitsThisWeek} visit{data.visitsThisWeek === 1 ? "" : "s"}
          </span>
        </Card>
      </div>
      <p className="text-xs text-muted">
        Your streak counts days in a row with a check-in, up to today (or
        yesterday if you haven&apos;t been in yet today).
      </p>
      {data.events.length === 0 ? (
        <EmptyState
          title="No check-ins yet"
          description="Show your card at the front desk to check in."
        />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border" data-testid="checkin-list">
            {data.events.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <span>
                  {e.type === "CHECK_OUT" ? "Checked out" : "Checked in"} ·{" "}
                  {e.branch}
                </span>
                <time
                  dateTime={e.occurredAt.toISOString()}
                  className="text-muted"
                >
                  {e.occurredAt.toLocaleString("en-IN", {
                    timeZone: mctx.timezone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
