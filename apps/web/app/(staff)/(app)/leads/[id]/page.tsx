import { hasPermission } from "@gym/core/authz";
import {
  CALL_OUTCOMES,
  CATEGORY_LABEL,
  crmStaffOptions,
  getCrmSetup,
  getLead,
  trialClassOptions,
  type Touch,
} from "@gym/core/crm";
import { isAppError } from "@gym/core/errors";
import {
  ActionForm,
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  ConfirmDialog,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { localInputFromNow, tomorrowAt, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  assignLeadAction,
  bookTrialAction,
  cancelTaskAction,
  cancelTrialAction,
  completeTaskAction,
  convertLeadAction,
  createTaskAction,
  logActivityAction,
  markLostAction,
  markTrialAction,
  moveLeadAction,
  reopenLeadAction,
  updateLeadAction,
} from "../actions";
import { CATEGORY_TONE } from "../leads-tabs";

export const metadata: Metadata = { title: "Lead" };

const ACTIVITY_LABEL: Record<string, string> = {
  NOTE: "Note",
  CALL: "Call",
  EMAIL: "Email",
  MEETING: "Met",
  STAGE_CHANGE: "Stage",
  ASSIGNMENT: "Owner",
  TASK: "Task",
  TRIAL: "Trial",
  CAPTURE: "Enquiry",
  CONVERSION: "Joined",
  SYSTEM: "System",
};
const OUTCOME_LABEL: Record<(typeof CALL_OUTCOMES)[number], string> = {
  ANSWERED: "Answered",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  CALL_BACK: "Asked to call back",
  WRONG_NUMBER: "Wrong number",
};
const TRIAL_TONE = {
  BOOKED: "info",
  ATTENDED: "success",
  NO_SHOW: "danger",
  CANCELLED: "neutral",
} as const;

function TouchLine({
  label,
  touch,
  names,
}: {
  label: string;
  touch: Touch | null;
  names: Map<string, string>;
}) {
  if (!touch) return null;
  const parts = [
    touch.sourceId ? names.get(touch.sourceId) : null,
    touch.campaignId ? names.get(touch.campaignId) : null,
    touch.utm?.source
      ? `utm ${[touch.utm.source, touch.utm.medium, touch.utm.campaign].filter(Boolean).join(" / ")}`
      : null,
  ].filter(Boolean);
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{parts.join(" · ") || touch.via.toLowerCase()}</dd>
    </>
  );
}

export default async function LeadPage({
  params,
  searchParams,
}: PageProps<"/leads/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/leads/${id}`);
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const deps = services().deps;
  let lead;
  try {
    lead = await orUpgrade(getLead(deps, ctx, id));
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (!lead) return <UpgradeNotice title="Lead" feature="Leads and CRM" />;
  const [setup, staff, classes] = [
    await getCrmSetup(deps, ctx),
    await crmStaffOptions(deps, ctx, lead.branchId),
    await trialClassOptions(deps, ctx, lead.branchId),
  ];
  const names = new Map<string, string>([
    ...setup.sources.map((s) => [s.id, s.name] as const),
    ...setup.campaigns.map((c) => [c.id, c.name] as const),
  ]);
  const open = lead.status === "OPEN";
  const manage = lead.canManage && open;
  const canConvert = manage && hasPermission(ctx, "members.create");
  const back = `/leads/${lead.id}`;
  const inOneHour = localInputFromNow(60, ctx.timezone);
  const tomorrow10 = tomorrowAt("10:00", ctx.timezone);

  return (
    <>
      <Breadcrumbs
        items={[{ label: "Leads", href: "/leads" }, { label: lead.name }]}
      />
      <PageHeader
        title={lead.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={CATEGORY_TONE[lead.stage.category]}>
              {lead.stage.name}
            </Badge>
            {lead.status !== "OPEN" && (
              <Badge tone={lead.status === "WON" ? "success" : "danger"}>
                {lead.status.toLowerCase()}
              </Badge>
            )}
            <span>Score {lead.score.score}</span>
            <span className="text-muted">· {lead.branch.name}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {canConvert && !lead.convertedMember && (
              <ConfirmDialog
                trigger="Convert to member"
                triggerVariant="primary"
                title={`Make ${lead.name} a member?`}
                description="Creates a member record from these details, then opens the membership sale. The lead is won when the membership is paid."
                confirmLabel="Continue to the sale"
                confirmVariant="primary"
                formAction={convertLeadAction}
                fields={{ leadId: lead.id }}
              >
                {lead.duplicates.members.length > 0 && (
                  <div className="flex flex-col gap-2 text-sm">
                    <p>
                      Already a member? Link instead of creating a new record:
                    </p>
                    {lead.duplicates.members.map((m) => (
                      <label key={m.id} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="memberId"
                          value={m.id}
                          className="size-4"
                        />
                        {m.name} ({m.memberCode})
                      </label>
                    ))}
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="memberId"
                        value=""
                        defaultChecked
                        className="size-4"
                      />{" "}
                      Create a new member
                    </label>
                    <CheckboxField
                      name="confirmDuplicate"
                      label="Create even though the mobile/email matches"
                    />
                  </div>
                )}
              </ConfirmDialog>
            )}
            {canConvert && lead.convertedMember && (
              <a
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-white"
                href={`/members/${lead.convertedMember.id}/sell?leadId=${lead.id}`}
              >
                Sell membership
              </a>
            )}
            {manage && (
              <ConfirmDialog
                trigger="Mark as lost"
                title={`Mark ${lead.name} as lost?`}
                confirmLabel="Mark as lost"
                formAction={markLostAction}
                fields={{ leadId: lead.id, back }}
              >
                <SelectField
                  label="Reason"
                  name="lostReasonId"
                  required
                  placeholder="Pick one"
                  options={setup.lostReasons.map((r) => ({
                    value: r.id,
                    label: r.name,
                  }))}
                />
                <TextareaField label="Note (optional)" name="note" rows={2} />
              </ConfirmDialog>
            )}
            {lead.canManage && lead.status === "LOST" && (
              <form action={reopenLeadAction}>
                <input type="hidden" name="leadId" value={lead.id} />
                <Button type="submit" variant="outline">
                  Reopen
                </Button>
              </form>
            )}
          </div>
        }
      />
      <Flash params={sp} />
      {lead.status === "WON" && lead.convertedMember && (
        <Alert tone="success" className="mb-4">
          Joined as{" "}
          <a
            className="font-medium underline"
            href={`/members/${lead.convertedMember.id}`}
          >
            {lead.convertedMember.name} ({lead.convertedMember.memberCode})
          </a>
          .
        </Alert>
      )}
      {lead.status === "OPEN" && lead.convertedMember && (
        <Alert tone="info" className="mb-4">
          Member record created ({lead.convertedMember.memberCode}). The lead is
          won when a membership sold from here is paid.
        </Alert>
      )}
      {lead.status === "LOST" && (
        <Alert tone="warning" className="mb-4">
          Lost: {lead.lostReason?.name}
          {lead.lostNote ? ` — ${lead.lostNote}` : ""}
        </Alert>
      )}
      {(lead.duplicates.leads.length > 0 ||
        lead.duplicates.members.length > 0) && (
        <Alert
          tone="info"
          className="mb-4"
          title="Same mobile or email elsewhere"
        >
          {[
            ...lead.duplicates.leads.map((d) => (
              <a key={d.id} className="mr-3 underline" href={`/leads/${d.id}`}>
                {d.name} (lead, {d.stage})
              </a>
            )),
            ...lead.duplicates.members.map((m) => (
              <a
                key={m.id}
                className="mr-3 underline"
                href={`/members/${m.id}`}
              >
                {m.name} ({m.memberCode})
              </a>
            )),
          ]}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="timeline" className="flex flex-col gap-4">
          {manage && (
            <Card>
              <CardTitle>Log a call, note or visit</CardTitle>
              <ActionForm
                action={logActivityAction}
                resetOnSuccess
                className="mt-3 flex flex-col gap-3"
              >
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField
                    label="What"
                    name="type"
                    defaultValue="CALL"
                    options={[
                      { value: "CALL", label: "Phone call" },
                      { value: "NOTE", label: "Note" },
                      { value: "EMAIL", label: "Email sent" },
                      { value: "MEETING", label: "Met in person" },
                    ]}
                  />
                  <SelectField
                    label="Call outcome"
                    name="outcome"
                    defaultValue="ANSWERED"
                    options={CALL_OUTCOMES.map((o) => ({
                      value: o,
                      label: OUTCOME_LABEL[o],
                    }))}
                    hint="For calls only."
                  />
                </div>
                <TextareaField label="Details" name="body" rows={2} />
                <div>
                  <SubmitButton variant="outline">Log it</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}
          <h2 id="timeline" className="text-base font-semibold">
            Timeline
          </h2>
          <ol className="flex flex-col gap-3">
            {lead.activities.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-border bg-surface p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">
                      {ACTIVITY_LABEL[a.type] ?? a.type}
                    </Badge>
                    {a.type === "CALL" &&
                      (a.meta as { outcome?: keyof typeof OUTCOME_LABEL })
                        ?.outcome && (
                        <span className="text-xs text-muted">
                          {
                            OUTCOME_LABEL[
                              (
                                a.meta as {
                                  outcome: keyof typeof OUTCOME_LABEL;
                                }
                              ).outcome
                            ]
                          }
                        </span>
                      )}
                  </span>
                  <span className="text-xs text-muted">
                    {when(a.createdAt, ctx.timezone)}
                    {a.user ? ` · ${a.user}` : ""}
                  </span>
                </div>
                {a.body && <p className="mt-1 whitespace-pre-wrap">{a.body}</p>}
              </li>
            ))}
          </ol>
        </section>

        <aside className="flex flex-col gap-4">
          <Card>
            <CardTitle>Details</CardTitle>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1.5 text-sm">
              <dt className="text-muted">Mobile</dt>
              <dd>
                {lead.phone ? (
                  <a
                    className="text-primary underline"
                    href={`tel:${lead.phone}`}
                  >
                    {lead.phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">
                {lead.email ? (
                  <a
                    className="text-primary underline"
                    href={`mailto:${lead.email}`}
                  >
                    {lead.email}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted">Interested in</dt>
              <dd>{lead.interest ?? "—"}</dd>
              <dt className="text-muted">Source</dt>
              <dd>{lead.source?.name ?? "—"}</dd>
              <dt className="text-muted">Campaign</dt>
              <dd>{lead.campaign?.name ?? "—"}</dd>
              <TouchLine
                label="First touch"
                touch={lead.firstTouch}
                names={names}
              />
              <TouchLine
                label="Latest touch"
                touch={lead.lastTouch}
                names={names}
              />
              <dt className="text-muted">Consent</dt>
              <dd>
                {lead.consentText ? (
                  <span title={lead.consentText}>
                    Yes
                    {lead.consentAt
                      ? `, ${when(lead.consentAt, ctx.timezone)}`
                      : ""}
                  </span>
                ) : (
                  "Not recorded"
                )}
                {lead.marketingConsent ? " · offers OK" : ""}
              </dd>
              <dt className="text-muted">Added</dt>
              <dd>{when(lead.createdAt, ctx.timezone)}</dd>
            </dl>
            {lead.canManage && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-medium text-primary">
                  Edit details
                </summary>
                <ActionForm
                  action={updateLeadAction}
                  className="mt-3 flex flex-col gap-3"
                >
                  <input type="hidden" name="leadId" value={lead.id} />
                  <FormField
                    label="First name"
                    name="firstName"
                    defaultValue={lead.firstName}
                    required
                  />
                  <FormField
                    label="Last name"
                    name="lastName"
                    defaultValue={lead.lastName ?? ""}
                  />
                  <FormField
                    label="Mobile"
                    name="phone"
                    defaultValue={lead.phone ?? ""}
                  />
                  <FormField
                    label="Email"
                    name="email"
                    defaultValue={lead.email ?? ""}
                  />
                  <FormField
                    label="Interested in"
                    name="interest"
                    defaultValue={lead.interest ?? ""}
                  />
                  <SelectField
                    label="Source"
                    name="sourceId"
                    defaultValue={lead.sourceId ?? ""}
                    placeholder="None"
                    options={setup.sources.map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                  />
                  <SelectField
                    label="Campaign"
                    name="campaignId"
                    defaultValue={lead.campaignId ?? ""}
                    placeholder="None"
                    options={setup.campaigns.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                  />
                  <CheckboxField
                    name="marketingConsent"
                    label="Agreed to offers and news"
                    defaultChecked={lead.marketingConsent}
                  />
                  <div>
                    <SubmitButton variant="outline">Save</SubmitButton>
                  </div>
                </ActionForm>
              </details>
            )}
          </Card>

          <Card>
            <CardTitle>Owner and stage</CardTitle>
            <p className="mt-2 text-sm">
              {lead.owner ? lead.owner.name : "Nobody yet"}
            </p>
            {open && (lead.canAssign || (lead.canManage && !lead.owner)) && (
              <form
                action={assignLeadAction}
                className="mt-2 flex items-end gap-2"
              >
                <input type="hidden" name="leadId" value={lead.id} />
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="sr-only">New owner</span>
                  <select
                    name="ownerUserId"
                    defaultValue={lead.owner?.userId ?? ctx.userId}
                    className="h-9 rounded-md border border-border bg-surface px-2"
                  >
                    {lead.canAssign && <option value="none">Nobody</option>}
                    {staff
                      .filter((s) => lead.canAssign || s.userId === ctx.userId)
                      .map((s) => (
                        <option key={s.userId} value={s.userId}>
                          {s.userId === ctx.userId ? `${s.name} (me)` : s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button type="submit" size="sm" variant="outline">
                  {lead.canAssign ? "Give" : "Take it"}
                </Button>
              </form>
            )}
            {manage && (
              <form
                action={moveLeadAction}
                className="mt-3 flex items-end gap-2"
              >
                <input type="hidden" name="leadId" value={lead.id} />
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="sr-only">Stage</span>
                  <select
                    name="stageId"
                    defaultValue={lead.stageId}
                    className="h-9 rounded-md border border-border bg-surface px-2"
                  >
                    {setup.stages
                      .filter(
                        (s) => s.category !== "WON" && s.category !== "LOST",
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button type="submit" size="sm" variant="outline">
                  Move
                </Button>
              </form>
            )}
          </Card>

          <Card>
            <CardTitle>Score: {lead.score.score}</CardTitle>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {lead.score.parts.length === 0 && (
                <li className="text-muted">No points yet.</li>
              )}
              {lead.score.parts.map((p) => (
                <li key={p.rule} className="flex justify-between">
                  <span>{p.label}</span>
                  <span className={p.points < 0 ? "text-danger" : ""}>
                    {p.points > 0 ? `+${p.points}` : p.points}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              Points from simple rules, so you can see why. Not a prediction.
            </p>
          </Card>

          <Card>
            <CardTitle>Tasks</CardTitle>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {lead.tasks.length === 0 && <li className="text-muted">None.</li>}
              {lead.tasks.map((t) => (
                <li key={t.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={
                        t.status !== "OPEN" ? "text-muted line-through" : ""
                      }
                    >
                      {t.title}
                    </span>
                    {t.status === "OPEN" && t.dueAt < new Date() && (
                      <Badge tone="danger">overdue</Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {t.status === "OPEN"
                      ? `Due ${when(t.dueAt, ctx.timezone)}`
                      : t.status.toLowerCase()}
                    {t.assignee ? ` · ${t.assignee}` : ""}
                  </span>
                  {t.status === "OPEN" &&
                    (t.assigneeUserId === ctx.userId || lead.canAssign) && (
                      <span className="mt-1 flex gap-2">
                        <form action={completeTaskAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="back" value={back} />
                          <Button type="submit" size="sm" variant="ghost">
                            Done
                          </Button>
                        </form>
                        <form action={cancelTaskAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="back" value={back} />
                          <Button type="submit" size="sm" variant="ghost">
                            Cancel
                          </Button>
                        </form>
                      </span>
                    )}
                </li>
              ))}
            </ul>
            {open &&
              hasPermission(ctx, "tasks.manage", {
                branchId: lead.branchId,
              }) && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer font-medium text-primary">
                    Add a task
                  </summary>
                  <ActionForm
                    action={createTaskAction}
                    resetOnSuccess
                    className="mt-3 flex flex-col gap-3"
                  >
                    <input type="hidden" name="leadId" value={lead.id} />
                    <FormField
                      label="Task"
                      name="title"
                      required
                      defaultValue={`Call ${lead.firstName} back`}
                    />
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
                      defaultValue={lead.owner?.userId ?? ctx.userId}
                      options={staff.map((s) => ({
                        value: s.userId,
                        label:
                          s.userId === ctx.userId ? `${s.name} (me)` : s.name,
                      }))}
                    />
                    <div>
                      <SubmitButton variant="outline">Add task</SubmitButton>
                    </div>
                  </ActionForm>
                </details>
              )}
          </Card>

          <Card>
            <CardTitle>Trials</CardTitle>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {lead.trials.length === 0 && (
                <li className="text-muted">None booked.</li>
              )}
              {lead.trials.map((t) => (
                <li key={t.id} className="rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span>{t.classSession?.name ?? "Gym trial"}</span>
                    <Badge tone={TRIAL_TONE[t.status]}>
                      {t.status.replace("_", " ").toLowerCase()}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted">
                    {when(t.startsAt, ctx.timezone)}
                  </span>
                  {t.status === "BOOKED" && (
                    <span className="mt-1 flex flex-wrap gap-2">
                      <a
                        className="text-xs text-primary underline"
                        href={`/t/${t.passCode}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Trial pass
                      </a>
                      {lead.canManage && (
                        <>
                          <form action={markTrialAction}>
                            <input type="hidden" name="trialId" value={t.id} />
                            <input
                              type="hidden"
                              name="outcome"
                              value="ATTENDED"
                            />
                            <input type="hidden" name="back" value={back} />
                            <Button type="submit" size="sm" variant="ghost">
                              Came
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
                  )}
                </li>
              ))}
            </ul>
            {manage && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-medium text-primary">
                  Book a trial
                </summary>
                <ActionForm
                  action={bookTrialAction}
                  className="mt-3 flex flex-col gap-3"
                >
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="mode" value="SLOT" />
                  <FormField
                    label="Gym visit at"
                    name="start"
                    type="datetime-local"
                    required
                    defaultValue={inOneHour}
                  />
                  <SelectField
                    label="Length"
                    name="minutes"
                    defaultValue="60"
                    options={[
                      { value: "30", label: "30 minutes" },
                      { value: "60", label: "1 hour" },
                      { value: "90", label: "1½ hours" },
                    ]}
                  />
                  <CheckboxField
                    name="sendConfirmation"
                    label="Email them the trial pass"
                    defaultChecked={!!lead.email}
                    disabled={!lead.email}
                  />
                  <div>
                    <SubmitButton variant="outline">
                      Book gym visit
                    </SubmitButton>
                  </div>
                </ActionForm>
                {classes.length > 0 && (
                  <ActionForm
                    action={bookTrialAction}
                    className="mt-4 flex flex-col gap-3 border-t border-border pt-3"
                  >
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="mode" value="CLASS" />
                    <SelectField
                      label="Or a class"
                      name="classSessionId"
                      required
                      placeholder="Pick a class"
                      options={classes.map((c) => ({
                        value: c.id,
                        label: c.label,
                      }))}
                    />
                    <CheckboxField
                      name="sendConfirmation"
                      label="Email them the trial pass"
                      defaultChecked={!!lead.email}
                      disabled={!lead.email}
                    />
                    <div>
                      <SubmitButton variant="outline">Book class</SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </details>
            )}
          </Card>
          <p className="text-xs text-muted">
            Stages map to fixed steps (
            {Object.values(CATEGORY_LABEL).join(" → ")}) so reports stay right
            when you rename them.
          </p>
        </aside>
      </div>
    </>
  );
}
