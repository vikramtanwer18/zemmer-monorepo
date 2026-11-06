import {
  automationEditorOptions,
  describeStep,
  dryRunWorkflow,
  getWorkflow,
  TRIGGER_LABELS,
} from "@gym/core/automation";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveAction, stopExecutionAction, toggleAction } from "../actions";
import { AutomationsTabs, EXEC_TONE } from "../automations-tabs";
import { WorkflowEditor } from "../workflow-editor";

export const metadata: Metadata = { title: "Workflow" };

export default async function WorkflowPage({
  params,
  searchParams,
}: PageProps<"/automations/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/automations/${id}`);
  if (!hasPermission(ctx, "automations.manage")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const data = await orUpgrade(getWorkflow(deps, ctx, id));
  if (!data) return <UpgradeNotice title="Automations" feature="Automations" />;
  const { workflow, definition, problems, executions, versions } = data;
  const canEdit = isTenantWritable(ctx);
  const dry =
    sp.dryrun && definition
      ? await dryRunWorkflow(deps, ctx, definition)
      : null;
  const options =
    canEdit && sp.edit ? await automationEditorOptions(deps, ctx) : null;
  return (
    <>
      <PageHeader
        title={workflow.name}
        description={
          definition
            ? TRIGGER_LABELS[definition.trigger.type].replace(
                "N days",
                `${definition.trigger.days ?? "N"} days`,
              )
            : ""
        }
        actions={
          <Badge tone={workflow.enabled ? "success" : "neutral"}>
            {workflow.enabled ? "On" : "Off"}
          </Badge>
        }
      />
      <AutomationsTabs current="/automations" showWorkflows />
      <Flash params={sp} />
      {problems.length > 0 && (
        <Alert tone="warning">
          Before it can be switched on: {problems.join(" ")}
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <CardTitle>
            What it does (version{" "}
            {versions.find((v) => v.current)?.version ?? "—"})
          </CardTitle>
          {definition && (
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {definition.steps.map((s, i) => (
                <li key={i}>{describeStep(s)}</li>
              ))}
            </ol>
          )}
          {definition?.exitWhen.length ? (
            <p className="text-xs text-muted">
              Stops early when: {definition.exitWhen.join(", ").toLowerCase()}.
            </p>
          ) : null}
          {definition?.conditions.length ? (
            <p className="text-xs text-muted">
              Only when {definition.conditions.length} condition(s) hold.
            </p>
          ) : null}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <form action={toggleAction}>
                <input type="hidden" name="workflowId" value={workflow.id} />
                <input
                  type="hidden"
                  name="enabled"
                  value={workflow.enabled ? "false" : "true"}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant={workflow.enabled ? "outline" : "primary"}
                >
                  {workflow.enabled ? "Switch off" : "Switch on"}
                </Button>
              </form>
              <LinkButton
                href={`/automations/${workflow.id}?dryrun=1`}
                size="sm"
                variant="outline"
              >
                Dry run (last 7 days)
              </LinkButton>
              <LinkButton
                href={`/automations/${workflow.id}?edit=1`}
                size="sm"
                variant="ghost"
              >
                Edit
              </LinkButton>
              <ConfirmDialog
                trigger="Archive"
                title="Archive this workflow?"
                description="It stops starting; its history stays."
                confirmLabel="Archive"
                formAction={archiveAction}
                fields={{ workflowId: workflow.id }}
              />
            </div>
          )}
        </Card>
        {dry && (
          <Card className="flex flex-col gap-2" data-testid="dry-run">
            <CardTitle>Dry run: last 7 days</CardTitle>
            <p className="text-sm">
              Triggered {dry.triggered} time(s); would have started for{" "}
              <b>{dry.wouldStart}</b> (conditions applied). Nothing was sent.
            </p>
            <ul className="text-sm">
              {dry.rows.slice(0, 20).map((r, i) => (
                <li
                  key={i}
                  className={r.passes ? "" : "text-muted line-through"}
                >
                  {r.name} · {r.when.slice(0, 10)}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {options && (
        <section className="mb-8">
          <WorkflowEditor
            workflowId={workflow.id}
            name={workflow.name}
            definition={definition}
            {...options}
          />
        </section>
      )}
      <h2 className="mb-3 text-base font-semibold">Runs</h2>
      <DataTable
        caption="Runs"
        rows={executions}
        rowKey={(e) => e.id}
        empty={
          <EmptyState
            title="No runs yet"
            description={
              workflow.enabled
                ? "It starts the next time its trigger happens."
                : "Switch it on to start."
            }
          />
        }
        columns={[
          {
            key: "who",
            header: "For",
            cell: (e) =>
              e.memberId ? (
                <a
                  className="text-primary underline"
                  href={`/members/${e.memberId}`}
                >
                  {e.subject}
                </a>
              ) : e.leadId ? (
                <a
                  className="text-primary underline"
                  href={`/leads/${e.leadId}`}
                >
                  {e.subject}
                </a>
              ) : (
                e.subject
              ),
          },
          {
            key: "status",
            header: "Status",
            cell: (e) => (
              <Badge tone={EXEC_TONE[e.status]}>
                {e.status.toLowerCase().replace("_", " ")}
              </Badge>
            ),
          },
          {
            key: "steps",
            header: "Steps",
            hideOnMobile: true,
            cell: (e) => (
              <span className="text-xs">
                {e.steps
                  .map(
                    (s) =>
                      `${s.index + 1}.${s.type} ${s.status.toLowerCase()}${s.result && typeof s.result === "object" && "reason" in s.result ? ` (${String(s.result.reason)})` : ""}`,
                  )
                  .join(" · ") || "—"}
                {e.status === "WAITING" && e.resumeAt
                  ? ` · next look ${when(e.resumeAt, ctx.timezone)}`
                  : ""}
                {e.error ? (
                  <span className="text-danger"> · {e.error}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: "started",
            header: "Started",
            cell: (e) => `${when(e.startedAt, ctx.timezone)} (v${e.version})`,
          },
          {
            key: "stop",
            header: "",
            cell: (e) =>
              canEdit &&
              ["RUNNING", "WAITING", "AWAITING_APPROVAL"].includes(e.status) ? (
                <ConfirmDialog
                  trigger="Stop"
                  title="Stop this run?"
                  description="Steps not done yet won't happen."
                  confirmLabel="Stop"
                  formAction={stopExecutionAction}
                  fields={{ executionId: e.id, workflowId: workflow.id }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
