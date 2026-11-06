import { listApprovals } from "@gym/core/automation";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { Button, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { decideAction } from "../actions";
import { AutomationsTabs } from "../automations-tabs";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage({
  searchParams,
}: PageProps<"/automations/approvals">) {
  const { ctx } = await requireReady("/automations/approvals");
  if (!hasPermission(ctx, "automations.approve")) return <NoAccess />;
  const sp = await searchParams;
  const rows = await orUpgrade(listApprovals(services().deps, ctx));
  if (!rows) return <UpgradeNotice title="Automations" feature="Automations" />;
  const canAct = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Automations"
        description="Steps that wait for a person. Nothing happens until someone approves; rejecting stops that run."
      />
      <AutomationsTabs
        current="/automations/approvals"
        showWorkflows={hasPermission(ctx, "automations.manage")}
      />
      <Flash params={sp} />
      <DataTable
        caption="Waiting for approval"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="Nothing to approve"
            description="Approval steps in workflows show up here."
          />
        }
        columns={[
          {
            key: "wf",
            header: "Workflow",
            cell: (r) => <span className="font-medium">{r.workflow}</span>,
          },
          {
            key: "who",
            header: "For",
            cell: (r) =>
              r.memberId ? (
                <a
                  className="text-primary underline"
                  href={`/members/${r.memberId}`}
                >
                  {r.subject}
                </a>
              ) : r.leadId ? (
                <a
                  className="text-primary underline"
                  href={`/leads/${r.leadId}`}
                >
                  {r.subject}
                </a>
              ) : (
                r.subject
              ),
          },
          { key: "note", header: "Question", cell: (r) => r.note },
          {
            key: "since",
            header: "Waiting since",
            hideOnMobile: true,
            cell: (r) => when(r.since, ctx.timezone),
          },
          {
            key: "act",
            header: "",
            cell: (r) =>
              canAct ? (
                <form action={decideAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="executionId" value={r.id} />
                  <input
                    name="note"
                    placeholder="Note (optional)"
                    aria-label="Note"
                    className="h-9 w-36 rounded-md border border-border bg-surface px-2 text-sm"
                  />
                  <Button
                    type="submit"
                    name="decision"
                    value="approve"
                    size="sm"
                  >
                    Approve
                  </Button>
                  <Button
                    type="submit"
                    name="decision"
                    value="reject"
                    size="sm"
                    variant="outline"
                  >
                    Reject
                  </Button>
                </form>
              ) : null,
          },
        ]}
      />
    </>
  );
}
