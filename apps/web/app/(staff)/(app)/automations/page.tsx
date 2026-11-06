import { listWorkflows, workflowLibrary } from "@gym/core/automation";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { installAction } from "./actions";
import { AutomationsTabs } from "./automations-tabs";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage({
  searchParams,
}: PageProps<"/automations">) {
  const { ctx } = await requireReady("/automations");
  if (!hasPermission(ctx, "automations.manage")) {
    if (hasPermission(ctx, "automations.approve"))
      redirect("/automations/approvals");
    return <NoAccess />;
  }
  const sp = await searchParams;
  const rows = await orUpgrade(listWorkflows(services().deps, ctx));
  if (!rows) return <UpgradeNotice title="Automations" feature="Automations" />;
  const installed = new Set(rows.map((r) => r.templateKey).filter(Boolean));
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Automations"
        description="Rules that react to what happens (a lead comes in, a membership is about to end) with tasks, alerts and WhatsApp templates. Each runs once per trigger and stops when its goal is reached."
        actions={
          canEdit ? (
            <LinkButton href="/automations/new">New workflow</LinkButton>
          ) : null
        }
      />
      <AutomationsTabs current="/automations" showWorkflows />
      <Flash params={sp} />
      <DataTable
        caption="Workflows"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No workflows yet"
            description="Start from a ready-made one below."
          />
        }
        columns={[
          {
            key: "name",
            header: "Workflow",
            cell: (r) => (
              <a href={`/automations/${r.id}`} className="flex flex-col">
                <span className="font-medium text-primary underline">
                  {r.name}
                </span>
                <span className="text-xs text-muted">{r.trigger}</span>
              </a>
            ),
          },
          {
            key: "on",
            header: "Status",
            cell: (r) => (
              <Badge tone={r.enabled ? "success" : "neutral"}>
                {r.enabled ? "On" : "Off"}
              </Badge>
            ),
          },
          {
            key: "steps",
            header: "Steps",
            hideOnMobile: true,
            cell: (r) => <span className="text-xs">{r.steps.join(" → ")}</span>,
          },
          {
            key: "runs",
            header: "Last 30 days",
            cell: (r) => (
              <span className="text-xs">
                {Object.values(r.last30).reduce((a, b) => a + b, 0)} started
                {r.last30.FAILED ? (
                  <span className="text-danger">
                    {" "}
                    · {r.last30.FAILED} failed
                  </span>
                ) : null}
                {r.last30.AWAITING_APPROVAL ? (
                  <span>
                    {" "}
                    · {r.last30.AWAITING_APPROVAL} waiting for approval
                  </span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <section className="mt-8" aria-labelledby="library">
        <h2 id="library" className="mb-3 text-base font-semibold">
          Ready-made workflows
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {workflowLibrary().map((w) => (
            <Card key={w.key} className="flex flex-col gap-2">
              <CardTitle>{w.name}</CardTitle>
              <p className="flex-1 text-sm text-muted">{w.description}</p>
              {canEdit && (
                <form action={installAction}>
                  <input type="hidden" name="key" value={w.key} />
                  <Button type="submit" size="sm" variant="outline">
                    {installed.has(w.key)
                      ? "Install another copy"
                      : "Install (switched off)"}
                  </Button>
                </form>
              )}
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}
