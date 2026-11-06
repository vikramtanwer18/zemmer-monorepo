import { hasPermission } from "@gym/core/authz";
import { CATEGORY_LABEL, getCrmSetup, STAGE_CATEGORIES } from "@gym/core/crm";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../settings-tabs";
import {
  archiveLostReasonAction,
  archiveStageAction,
  createLostReasonAction,
  createSourceAction,
  createStageAction,
  crmSettingsAction,
  moveStageAction,
  renameStageAction,
  sourcePointsAction,
} from "./actions";
import { CrmSettingsTabs } from "./crm-tabs";

export const metadata: Metadata = { title: "Lead settings" };

export default async function CrmSettingsPage({
  searchParams,
}: PageProps<"/settings/crm">) {
  const { ctx } = await requireReady("/settings/crm");
  if (!hasPermission(ctx, "crm.configure")) return <NoAccess />;
  const sp = await searchParams;
  const setup = await orUpgrade(getCrmSetup(services().deps, ctx));
  if (!setup) return <UpgradeNotice title="Settings" feature="Leads and CRM" />;
  const order = setup.stages.map((s) => s.id).join(",");
  const input = "h-9 rounded-md border border-border bg-surface px-2 text-sm";
  return (
    <>
      <PageHeader
        title="Settings"
        description="How leads move, who gets them, and how fast they must be contacted."
      />
      <SettingsTabs current="/settings/crm" />
      <CrmSettingsTabs current="/settings/crm" />
      <Flash params={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="stages" className="flex flex-col gap-3">
          <h2 id="stages" className="text-base font-semibold">
            Pipeline stages
          </h2>
          <p className="text-sm text-muted">
            Rename, reorder and add stages. Each belongs to one fixed step (
            {STAGE_CATEGORIES.map((c) => CATEGORY_LABEL[c]).join(" → ")}), so
            reports keep working. Stages stay in funnel order; reorder within a
            step.
          </p>
          <ol className="flex flex-col gap-2">
            {setup.stages.map((s, i) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2"
              >
                <span className="flex flex-col">
                  <button
                    form={`up-${s.id}`}
                    type="submit"
                    disabled={i === 0}
                    className="text-xs disabled:opacity-30"
                    aria-label={`Move ${s.name} up`}
                  >
                    ▲
                  </button>
                  <button
                    form={`down-${s.id}`}
                    type="submit"
                    disabled={i === setup.stages.length - 1}
                    className="text-xs disabled:opacity-30"
                    aria-label={`Move ${s.name} down`}
                  >
                    ▼
                  </button>
                </span>
                <form id={`up-${s.id}`} action={moveStageAction} hidden>
                  <input type="hidden" name="stageId" value={s.id} />
                  <input type="hidden" name="dir" value="up" />
                  <input type="hidden" name="order" value={order} />
                </form>
                <form id={`down-${s.id}`} action={moveStageAction} hidden>
                  <input type="hidden" name="stageId" value={s.id} />
                  <input type="hidden" name="dir" value="down" />
                  <input type="hidden" name="order" value={order} />
                </form>
                <form
                  action={renameStageAction}
                  className="flex flex-1 items-center gap-2"
                >
                  <input type="hidden" name="stageId" value={s.id} />
                  <label className="sr-only" htmlFor={`stage-${s.id}`}>
                    Name of stage {i + 1}
                  </label>
                  <input
                    id={`stage-${s.id}`}
                    name="name"
                    defaultValue={s.name}
                    required
                    minLength={2}
                    maxLength={40}
                    className={`${input} min-w-0 flex-1`}
                  />
                  <Button type="submit" size="sm" variant="ghost">
                    Rename
                  </Button>
                </form>
                <Badge tone="neutral">{CATEGORY_LABEL[s.category]}</Badge>
                <span className="text-xs text-muted">{s.leads} lead(s)</span>
                <ConfirmDialog
                  trigger="Remove"
                  triggerVariant="ghost"
                  title={`Remove the stage "${s.name}"?`}
                  description={
                    s.leads
                      ? "Its leads move to the stage you pick (same step only)."
                      : "It has no leads."
                  }
                  confirmLabel="Remove stage"
                  formAction={archiveStageAction}
                  fields={{ stageId: s.id }}
                >
                  {s.leads > 0 && (
                    <SelectField
                      label="Move its leads to"
                      name="moveTo"
                      required
                      placeholder="Pick a stage"
                      options={setup.stages
                        .filter(
                          (o) => o.id !== s.id && o.category === s.category,
                        )
                        .map((o) => ({ value: o.id, label: o.name }))}
                    />
                  )}
                </ConfirmDialog>
              </li>
            ))}
          </ol>
          <ActionForm
            action={createStageAction}
            resetOnSuccess
            className="flex flex-wrap items-end gap-2"
          >
            <FormField
              label="New stage"
              name="name"
              required
              placeholder="e.g. Hot — call today"
            />
            <SelectField
              label="Step"
              name="category"
              defaultValue="CONTACTED"
              options={STAGE_CATEGORIES.map((c) => ({
                value: c,
                label: CATEGORY_LABEL[c],
              }))}
            />
            <SubmitButton variant="outline">Add stage</SubmitButton>
          </ActionForm>
        </section>

        <aside className="flex flex-col gap-4">
          <Card>
            <CardTitle>Assignment and speed</CardTitle>
            <ActionForm
              action={crmSettingsAction}
              className="mt-3 flex flex-col gap-3"
            >
              <SelectField
                label="New leads go to"
                name="leadAssignment"
                defaultValue={setup.settings.leadAssignment}
                options={[
                  { value: "MANUAL", label: "Nobody until someone picks them" },
                  {
                    value: "ROUND_ROBIN",
                    label: "Sales staff in turn (per branch)",
                  },
                ]}
              />
              <FormField
                label="First contact within (minutes)"
                name="leadFirstContactMinutes"
                type="number"
                min={1}
                max={10080}
                defaultValue={setup.settings.leadFirstContactMinutes}
                hint="Managers are alerted when a lead waits longer."
              />
              <FormField
                label="Remind before a task is due (minutes)"
                name="taskReminderMinutes"
                type="number"
                min={0}
                max={1440}
                defaultValue={setup.settings.taskReminderMinutes}
                hint="0 = no reminders."
              />
              <div>
                <SubmitButton variant="outline">Save</SubmitButton>
              </div>
            </ActionForm>
          </Card>

          <Card>
            <CardTitle>Sources and score points</CardTitle>
            <p className="mt-1 text-xs text-muted">
              A lead starts with its source&apos;s points (−20 to 30).
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {setup.sources.map((s) => (
                <li key={s.id}>
                  <form
                    action={sourcePointsAction}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input type="hidden" name="sourceId" value={s.id} />
                    <span className="flex-1">{s.name}</span>
                    <label className="sr-only" htmlFor={`pts-${s.id}`}>
                      Points for {s.name}
                    </label>
                    <input
                      id={`pts-${s.id}`}
                      name="points"
                      type="number"
                      min={-20}
                      max={30}
                      defaultValue={s.points}
                      className={`${input} w-16`}
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      Save
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            <ActionForm
              action={createSourceAction}
              resetOnSuccess
              className="mt-3 flex items-end gap-2"
            >
              <FormField
                label="New source"
                name="name"
                required
                placeholder="e.g. Justdial"
              />
              <SubmitButton variant="outline">Add</SubmitButton>
            </ActionForm>
          </Card>

          <Card>
            <CardTitle>Lost reasons</CardTitle>
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {setup.lostReasons.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2"
                >
                  {r.name}
                  <form action={archiveLostReasonAction}>
                    <input type="hidden" name="reasonId" value={r.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${r.name}`}
                    >
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            <ActionForm
              action={createLostReasonAction}
              resetOnSuccess
              className="mt-3 flex items-end gap-2"
            >
              <FormField label="New reason" name="name" required />
              <SubmitButton variant="outline">Add</SubmitButton>
            </ActionForm>
          </Card>
        </aside>
      </div>
    </>
  );
}
