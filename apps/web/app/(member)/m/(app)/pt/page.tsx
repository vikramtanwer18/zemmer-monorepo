import { listMyPt } from "@gym/core/staff";
import { Badge, Card, EmptyState } from "@gym/ui";
import type { Metadata } from "next";
import { day } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Personal training" };

const STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "neutral" }
> = {
  ACTIVE: { label: "Active", tone: "success" },
  PENDING_PAYMENT: { label: "Waiting for payment", tone: "warning" },
  EXHAUSTED: { label: "All sessions used", tone: "neutral" },
};

export default async function MyPtPage() {
  const { mctx } = await requireMember("/m/pt");
  const { balances, upcoming } = await listMyPt(services().deps, mctx);
  return (
    <>
      <h1 className="text-xl font-semibold">Personal training</h1>
      {balances.length === 0 ? (
        <EmptyState
          title="No PT packages"
          description="Ask at the front desk about personal training."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {balances.map((b) => (
            <li key={b.id}>
              <Card className="flex flex-col gap-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{b.name}</p>
                  <Badge tone={STATUS[b.status]?.tone ?? "neutral"}>
                    {STATUS[b.status]?.label ?? b.status}
                  </Badge>
                </div>
                <p className="text-sm">
                  {b.left} of {b.sessionsTotal} sessions left
                  {b.scheduled ? ` · ${b.scheduled} booked` : ""}
                </p>
                <p className="text-xs text-muted">
                  {b.trainer ? `With ${b.trainer}. ` : ""}
                  {b.expiresOn ? `Use by ${day(b.expiresOn)}.` : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <h2 className="text-base font-semibold">Upcoming sessions</h2>
      {upcoming.length === 0 ? (
        <p className="text-sm text-muted">
          No sessions booked. Your trainer or the front desk books them for you.
        </p>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {upcoming.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <p className="font-medium">
                  {day(a.date)} at {a.startTime}
                </p>
                <p className="text-muted">
                  {a.trainer} · {a.branch}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
