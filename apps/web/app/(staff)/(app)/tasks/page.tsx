import { hasPermission } from "@gym/core/authz";
import { crmStaffOptions, listTasks } from "@gym/core/crm";
import { utcToLocalDateTime } from "@gym/core/time/dates";
import {
  ActionForm,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  Tabs,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { str, tomorrowAt, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  cancelTaskAction,
  completeTaskAction,
  createTaskAction,
  rescheduleTaskAction,
} from "../leads/actions";

export const metadata: Metadata = { title: "Tasks" };

const WHEN = [
  { value: "all", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Later" },
  { value: "done", label: "Done" },
] as const;
const KIND = {
  FIRST_CONTACT: "First contact",
  FOLLOW_UP: "Follow-up",
  CALLBACK: "Call back",
  TRIAL: "After trial",
  OTHER: "Other",
} as const;

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const { ctx } = await requireReady("/tasks");
  if (!hasPermission(ctx, "tasks.manage")) return <NoAccess />;
  const sp = await searchParams;
  const team = str(sp.scope) === "team" && hasPermission(ctx, "leads.assign");
  const whenFilter = WHEN.find((w) => w.value === str(sp.when))?.value ?? "all";
  const data = await orUpgrade(
    listTasks(services().deps, ctx, {
      scope: team ? "team" : "mine",
      when: whenFilter,
      assignee: str(sp.assignee),
    }),
  );
  if (!data) return <UpgradeNotice title="Tasks" feature="Leads and CRM" />;
  const staff = await crmStaffOptions(services().deps, ctx, ctx.activeBranchId);
  const q = (over: Record<string, string>) =>
    `/tasks?${new URLSearchParams({ ...(team ? { scope: "team" } : {}), when: whenFilter, ...over })}`;
  const back = q({});
  const tomorrow10 = tomorrowAt("10:00", ctx.timezone);
  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          team ? "Everyone's follow-ups" : "Your follow-ups, soonest first"
        }
      />
      {hasPermission(ctx, "leads.assign") && (
        <Tabs
          label="Whose tasks"
          current={team ? "/tasks?scope=team" : "/tasks"}
          items={[
            { href: "/tasks", label: "Mine" },
            { href: "/tasks?scope=team", label: "Team" },
          ]}
        />
      )}
      <Flash params={sp} />
      <nav
        aria-label="Which tasks"
        className="mb-4 flex flex-wrap gap-2 text-sm"
      >
        {WHEN.map((w) => (
          <a
            key={w.value}
            href={q({ when: w.value })}
            aria-current={whenFilter === w.value ? "true" : undefined}
            className={`rounded-md border px-3 py-1.5 ${whenFilter === w.value ? "border-primary font-medium" : "border-border"}`}
          >
            {w.label}
          </a>
        ))}
      </nav>
      <DataTable
        caption="Tasks"
        rows={data.rows}
        rowKey={(t) => t.id}
        empty={
          <EmptyState
            title="Nothing here"
            description={
              whenFilter === "overdue"
                ? "No overdue tasks. Nice."
                : "No tasks in this view."
            }
          />
        }
        columns={[
          {
            key: "task",
            header: "Task",
            cell: (t) => (
              <span className="flex flex-col">
                <span
                  className={`font-medium ${t.status !== "OPEN" ? "text-muted line-through" : ""}`}
                >
                  {t.title}
                </span>
                {t.lead && (
                  <a
                    className="text-xs text-primary underline"
                    href={`/leads/${t.lead.id}`}
                  >
                    {t.lead.name}
                    {t.lead.phone ? ` · ${t.lead.phone}` : ""}
                  </a>
                )}
                {t.member && (
                  <a
                    className="text-xs text-primary underline"
                    href={`/members/${t.member.id}`}
                  >
                    {t.member.name}
                  </a>
                )}
              </span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            hideOnMobile: true,
            cell: (t) => KIND[t.kind],
          },
          {
            key: "due",
            header: "Due",
            cell: (t) => (
              <span className="flex flex-col text-sm">
                {when(t.dueAt, ctx.timezone)}
                {t.overdue && <Badge tone="danger">overdue</Badge>}
                {t.status !== "OPEN" && (
                  <span className="text-xs text-muted">
                    {t.status.toLowerCase()}
                    {t.outcome ? `: ${t.outcome}` : ""}
                  </span>
                )}
              </span>
            ),
          },
          ...(team
            ? [
                {
                  key: "who",
                  header: "For",
                  hideOnMobile: true,
                  cell: (t: (typeof data.rows)[number]) =>
                    t.assignee ?? "Nobody",
                },
              ]
            : []),
          {
            key: "actions",
            header: "",
            cell: (t) =>
              t.status === "OPEN" ? (
                <span className="flex flex-wrap gap-1">
                  <ConfirmDialog
                    trigger="Done"
                    triggerVariant="primary"
                    title={`Done: ${t.title}?`}
                    confirmLabel="Mark done"
                    confirmVariant="primary"
                    formAction={completeTaskAction}
                    fields={{ taskId: t.id, back }}
                  >
                    <FormField
                      label="Outcome (optional)"
                      name="outcome"
                      placeholder="e.g. Coming Saturday for a trial"
                    />
                  </ConfirmDialog>
                  <ConfirmDialog
                    trigger="Move"
                    triggerVariant="ghost"
                    title="New due time"
                    confirmLabel="Move"
                    confirmVariant="primary"
                    formAction={rescheduleTaskAction}
                    fields={{ taskId: t.id, back }}
                  >
                    <FormField
                      label="Due"
                      name="due"
                      type="datetime-local"
                      required
                      defaultValue={utcToLocalDateTime(t.dueAt, ctx.timezone)}
                    />
                  </ConfirmDialog>
                  <form action={cancelTaskAction}>
                    <input type="hidden" name="taskId" value={t.id} />
                    <input type="hidden" name="back" value={back} />
                    <Button type="submit" size="sm" variant="ghost">
                      Cancel
                    </Button>
                  </form>
                </span>
              ) : null,
          },
        ]}
      />
      <section aria-labelledby="add" className="mt-8 max-w-xl">
        <h2 id="add" className="mb-3 text-base font-semibold">
          Add a task
        </h2>
        <ActionForm
          action={createTaskAction}
          resetOnSuccess
          className="flex flex-col gap-3"
        >
          <FormField
            label="What"
            name="title"
            required
            placeholder="e.g. Call members whose plan ends this week"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Due"
              name="due"
              type="datetime-local"
              required
              defaultValue={tomorrow10}
            />
            <SelectField
              label="For"
              name="assigneeUserId"
              defaultValue={ctx.userId}
              options={staff.map((s) => ({
                value: s.userId,
                label: s.userId === ctx.userId ? `${s.name} (me)` : s.name,
              }))}
            />
          </div>
          <div>
            <SubmitButton variant="outline">Add task</SubmitButton>
          </div>
        </ActionForm>
      </section>
    </>
  );
}
