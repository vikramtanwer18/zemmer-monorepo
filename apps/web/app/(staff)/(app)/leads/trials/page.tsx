import { hasPermission } from "@gym/core/authz";
import { listTrials } from "@gym/core/crm";
import { addDays } from "@gym/core/time/dates";
import { Badge, Button, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { day, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { cancelTrialAction, markTrialAction } from "../actions";
import { LeadsTabs } from "../leads-tabs";

export const metadata: Metadata = { title: "Trials" };

const TONE = {
  BOOKED: "info",
  ATTENDED: "success",
  NO_SHOW: "danger",
  CANCELLED: "neutral",
} as const;

export default async function TrialsPage({
  searchParams,
}: PageProps<"/leads/trials">) {
  const { ctx } = await requireReady("/leads/trials");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const data = await orUpgrade(
    listTrials(services().deps, ctx, {
      date: str(sp.date),
      branchId: ctx.activeBranchId ?? undefined,
    }),
  );
  if (!data) return <UpgradeNotice title="Trials" feature="Leads and CRM" />;
  const canManage = hasPermission(ctx, "leads.manage");
  const back = `/leads/trials?date=${data.date}`;
  return (
    <>
      <PageHeader
        title="Leads"
        description="Trials on a day. Scan a trial pass on the Scan page, or mark it here."
      />
      <LeadsTabs current="/leads/trials" />
      <Flash params={sp} />
      <nav aria-label="Day" className="mb-4 flex items-center gap-3 text-sm">
        <a
          className="rounded-md border border-border px-3 py-1.5"
          href={`/leads/trials?date=${addDays(data.date, -1)}`}
        >
          ← Previous
        </a>
        <span className="font-medium">{day(data.date)}</span>
        <a
          className="rounded-md border border-border px-3 py-1.5"
          href={`/leads/trials?date=${addDays(data.date, 1)}`}
        >
          Next →
        </a>
        <a className="text-primary underline" href="/leads/trials">
          Today
        </a>
      </nav>
      <DataTable
        caption="Trials"
        rows={data.rows}
        rowKey={(t) => t.id}
        empty={
          <EmptyState
            title="No trials this day"
            description="Book one from a lead's page."
          />
        }
        columns={[
          {
            key: "time",
            header: "Time",
            cell: (t) =>
              t.startsAt.toLocaleTimeString("en-IN", {
                timeZone: ctx.timezone,
                timeStyle: "short",
              }),
          },
          {
            key: "lead",
            header: "Lead",
            cell: (t) => (
              <a
                className="font-medium text-primary underline"
                href={`/leads/${t.lead.id}`}
              >
                {t.lead.name}
                <span className="block text-xs font-normal text-muted">
                  {t.lead.phone}
                </span>
              </a>
            ),
          },
          {
            key: "what",
            header: "What",
            hideOnMobile: true,
            cell: (t) => t.classSession?.name ?? "Gym visit",
          },
          {
            key: "branch",
            header: "Branch",
            hideOnMobile: true,
            cell: (t) => t.branch.name,
          },
          {
            key: "status",
            header: "Status",
            cell: (t) => (
              <Badge tone={TONE[t.status]}>
                {t.status.replace("_", " ").toLowerCase()}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (t) =>
              canManage && (t.status === "BOOKED" || t.status === "NO_SHOW") ? (
                <span className="flex flex-wrap gap-1">
                  <form action={markTrialAction}>
                    <input type="hidden" name="trialId" value={t.id} />
                    <input type="hidden" name="outcome" value="ATTENDED" />
                    <input type="hidden" name="back" value={back} />
                    <Button type="submit" size="sm">
                      Came
                    </Button>
                  </form>
                  {t.status === "BOOKED" && (
                    <>
                      <form action={markTrialAction}>
                        <input type="hidden" name="trialId" value={t.id} />
                        <input type="hidden" name="outcome" value="NO_SHOW" />
                        <input type="hidden" name="back" value={back} />
                        <Button type="submit" size="sm" variant="ghost">
                          Didn&apos;t come
                        </Button>
                      </form>
                      <form action={cancelTrialAction}>
                        <input type="hidden" name="trialId" value={t.id} />
                        <input type="hidden" name="back" value={back} />
                        <Button type="submit" size="sm" variant="ghost">
                          Cancel
                        </Button>
                      </form>
                    </>
                  )}
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}
