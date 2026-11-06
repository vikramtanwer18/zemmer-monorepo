import { hasPermission } from "@gym/core/authz";
import { AGING_BUCKETS, duesReport } from "@gym/core/payments";
import { Badge, DataTable, EmptyState, PageHeader, StatCard } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { PaymentsTabs } from "../payments-tabs";

export const metadata: Metadata = { title: "Dues" };

const BUCKET_LABEL = {
  current: "Not yet due",
  "1-30": "1–30 days late",
  "31-60": "31–60 days late",
  "61-90": "61–90 days late",
  "90+": "Over 90 days late",
} as const;
const BUCKET_TONE = {
  current: "neutral",
  "1-30": "info",
  "31-60": "warning",
  "61-90": "warning",
  "90+": "danger",
} as const;

export default async function DuesPage({
  searchParams,
}: PageProps<"/payments/dues">) {
  const { ctx } = await requireReady("/payments/dues");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const bucket = AGING_BUCKETS.find((b) => b === str(sp.bucket));
  const report = await duesReport(services().deps, ctx, {});
  const rows = bucket
    ? report.members.filter((m) => m.worst === bucket)
    : report.members;
  return (
    <>
      <PageHeader
        title="Payments"
        description={`${inr(report.totalMinor)} owed by ${report.members.length} member${report.members.length === 1 ? "" : "s"}. Members get reminders on the days set in Settings → Online payments.`}
      />
      <PaymentsTabs current="/payments/dues" />
      <Flash params={sp} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <a
            key={b}
            href={
              bucket === b
                ? "/payments/dues"
                : `/payments/dues?bucket=${encodeURIComponent(b)}`
            }
            className={`rounded-lg ${bucket === b ? "ring-2 ring-primary" : ""}`}
            aria-current={bucket === b ? "true" : undefined}
          >
            <StatCard
              label={BUCKET_LABEL[b]}
              value={inr(report.totals[b])}
              tone={b === "90+" && report.totals[b] > 0 ? "danger" : "default"}
            />
          </a>
        ))}
      </div>
      <DataTable
        caption="Members with dues"
        rows={rows}
        rowKey={(m) => m.member.id}
        empty={
          <EmptyState
            title={bucket ? "Nobody in this group" : "No dues"}
            description={
              bucket ? "Pick another group above." : "Every invoice is paid."
            }
          />
        }
        columns={[
          {
            key: "member",
            header: "Member",
            cell: (m) => (
              <a
                className="font-medium text-primary underline"
                href={`/members/${m.member.id}?tab=billing`}
              >
                {m.member.name}
                <span className="block text-xs font-normal text-muted">
                  {m.member.memberCode}
                </span>
              </a>
            ),
          },
          { key: "due", header: "Owes", cell: (m) => inr(m.dueMinor) },
          {
            key: "invoices",
            header: "Invoices",
            hideOnMobile: true,
            cell: (m) => m.invoices,
          },
          {
            key: "oldest",
            header: "Oldest due",
            hideOnMobile: true,
            cell: (m) =>
              m.daysOverdue > 0
                ? `${m.oldestDue} (${m.daysOverdue} days ago)`
                : m.oldestDue,
          },
          {
            key: "bucket",
            header: "Status",
            cell: (m) => (
              <Badge tone={BUCKET_TONE[m.worst]}>{BUCKET_LABEL[m.worst]}</Badge>
            ),
          },
          {
            key: "phone",
            header: "Phone",
            hideOnMobile: true,
            cell: (m) =>
              m.member.phone ? (
                <a href={`tel:${m.member.phone}`}>{m.member.phone}</a>
              ) : (
                "—"
              ),
          },
        ]}
      />
    </>
  );
}
