import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import {
  campaignStats,
  estimateCampaign,
  listSegments,
} from "@gym/core/growth";
import {
  listTemplates,
  SKIP_REASONS,
  suggestVariableMap,
  VARIABLE_SOURCES,
  type VariableMap,
} from "@gym/core/messaging";
import {
  ActionForm,
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  FormField,
  PageHeader,
  StatCard,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { inr, localInputFromNow, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  cancelCampaignAction,
  configureAction,
  launchAction,
  testSendAction,
} from "../actions";
import { CampaignsTabs, SEND_STATUS } from "../campaigns-tabs";

export const metadata: Metadata = { title: "Campaign" };

const input = "h-10 rounded-md border border-border bg-surface px-3 text-sm";

export default async function CampaignPage({
  params,
  searchParams,
}: PageProps<"/campaigns/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/campaigns/${id}`);
  if (!hasPermission(ctx, "marketing.send")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const stats = await orUpgrade(campaignStats(deps, ctx, id));
  if (!stats)
    return <UpgradeNotice title="Campaigns" feature="WhatsApp campaigns" />;
  const c = stats.campaign;
  const editable =
    isTenantWritable(ctx) &&
    (c.sendStatus === "NONE" || c.sendStatus === "DRAFT");
  const [segments, templates] = editable
    ? [
        await listSegments(deps, ctx),
        await listTemplates(deps, ctx, { approvedOnly: true }),
      ]
    : [[], []];
  const templateId =
    typeof sp.template === "string" ? sp.template : c.templateId;
  const template = templates.find((t) => t.id === templateId);
  const map =
    (c.templateId === template?.id
      ? (c.variableMap as VariableMap | null)
      : null) ?? (template ? suggestVariableMap(template.variables) : {});
  let estimate: Awaited<ReturnType<typeof estimateCampaign>> | null = null;
  let estimateError: string | null = null;
  if (c.sendStatus === "DRAFT")
    try {
      estimate = await estimateCampaign(deps, ctx, id);
    } catch (err) {
      if (!isAppError(err)) throw err;
      estimateError = err.message;
    }
  const status = SEND_STATUS[c.sendStatus];
  return (
    <>
      <PageHeader
        title={c.name}
        description={`Tracking code ${c.code}`}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      />
      <CampaignsTabs current="/campaigns" />
      <Flash params={sp} />

      {editable && (
        <Card className="mb-6 flex flex-col gap-3">
          <CardTitle>1. Audience and message</CardTitle>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Template
              <select
                name="template"
                defaultValue={template?.id ?? ""}
                className={input}
              >
                <option value="">Choose an approved template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.category.toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="outline" size="sm">
              Use this template
            </Button>
          </form>
          {template && (
            <ActionForm
              action={configureAction}
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="campaignId" value={c.id} />
              <input type="hidden" name="templateId" value={template.id} />
              <p className="rounded-md bg-background p-3 text-sm">
                {template.bodyText}
              </p>
              {template.category === "MARKETING" && (
                <p className="text-xs text-muted">
                  Promotional template: only people with recorded WhatsApp
                  marketing consent get it, and nobody gets more promotions a
                  day than the limit in WhatsApp settings.
                </p>
              )}
              {template.variables.map((v) => {
                const b = map[v];
                return (
                  <div
                    key={v}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <code className="w-28 text-xs">{`{{${v}}}`}</code>
                    <select
                      name={`var_${v}`}
                      defaultValue={
                        b ? ("source" in b ? b.source : "text") : ""
                      }
                      className={input}
                      aria-label={`Value for ${v}`}
                    >
                      <option value="">Choose…</option>
                      {Object.entries(VARIABLE_SOURCES).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                      <option value="text">Fixed text…</option>
                    </select>
                    <input
                      name={`text_${v}`}
                      defaultValue={b && "text" in b ? b.text : ""}
                      placeholder="Fixed text (if chosen)"
                      className={`${input} flex-1`}
                      aria-label={`Fixed text for ${v}`}
                    />
                  </div>
                );
              })}
              <label className="flex flex-col gap-1 text-sm font-medium">
                Audience
                <select
                  name="segmentId"
                  required
                  defaultValue={c.segmentId ?? ""}
                  className={input}
                >
                  <option value="">Choose…</option>
                  {segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.summary}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  label="Messages per minute"
                  name="throttlePerMinute"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={c.throttlePerMinute}
                />
                <FormField
                  label="Count renewals/payments within (days)"
                  name="attributionDays"
                  type="number"
                  min={1}
                  max={90}
                  defaultValue={c.attributionDays}
                />
              </div>
              <div>
                <SubmitButton>Save</SubmitButton>
              </div>
            </ActionForm>
          )}
          {!segments.length && (
            <p className="text-sm text-muted">
              No audiences yet:{" "}
              <a
                className="text-primary underline"
                href="/campaigns/audiences/edit"
              >
                build one
              </a>
              .
            </p>
          )}
        </Card>
      )}

      {c.sendStatus === "DRAFT" && (
        <Card className="mb-6 flex flex-col gap-3" data-testid="launch">
          <CardTitle>2. Check and launch</CardTitle>
          {estimateError && <Alert tone="danger">{estimateError}</Alert>}
          {estimate && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard
                  label="Recipients"
                  value={String(estimate.recipients)}
                />
                <StatCard
                  label="Will get it (estimate)"
                  value={String(estimate.reachable)}
                  hint={
                    estimate.category === "MARKETING"
                      ? "with marketing consent"
                      : "service consent"
                  }
                />
                <StatCard
                  label="Opted out"
                  value={String(estimate.suppressed)}
                />
                <StatCard
                  label="Message type"
                  value={estimate.category.toLowerCase()}
                  hint={`${estimate.template.name} · Meta charges per ${estimate.category.toLowerCase()} conversation`}
                />
              </div>
              <p className="rounded-md bg-background p-3 text-sm">
                <span className="text-xs text-muted">
                  Preview for the first recipient:
                </span>
                <br />
                {estimate.preview}
              </p>
              <p className="text-xs text-muted">
                At {estimate.throttlePerMinute}/minute this takes about{" "}
                {estimate.minutes} minute(s). Everyone is checked again for
                consent and opt-outs at the moment their message is sent.
              </p>
              {isTenantWritable(ctx) && (
                <form action={launchAction} className="flex flex-col gap-3">
                  <input type="hidden" name="campaignId" value={c.id} />
                  <input
                    type="hidden"
                    name="confirmRecipients"
                    value={estimate.recipients}
                  />
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    Send at (empty = now)
                    <input
                      type="datetime-local"
                      name="scheduledAt"
                      min={localInputFromNow(0, ctx.timezone)}
                      className={input}
                    />
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="confirm"
                      required
                      className="mt-1"
                    />
                    <span>
                      Send this <b>{estimate.category.toLowerCase()}</b>{" "}
                      template to up to <b>{estimate.recipients}</b> people.
                    </span>
                  </label>
                  <div>
                    <Button type="submit">Launch</Button>
                  </div>
                </form>
              )}
            </>
          )}
          {isTenantWritable(ctx) && (
            <ActionForm
              action={testSendAction}
              className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end"
            >
              <input type="hidden" name="campaignId" value={c.id} />
              <FormField
                label="Test to staff number(s)"
                name="phones"
                placeholder="98765 43210"
                required
              />
              <SubmitButton variant="outline">Send test</SubmitButton>
            </ActionForm>
          )}
        </Card>
      )}

      {c.sendStatus !== "NONE" && c.sendStatus !== "DRAFT" && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              {stats.template?.name} → {stats.segment?.name}
            </span>
            {c.scheduledAt && (
              <span>Starts {when(c.scheduledAt, ctx.timezone)}</span>
            )}
            {c.completedAt && (
              <span>Finished {when(c.completedAt, ctx.timezone)}</span>
            )}
            {isTenantWritable(ctx) &&
              (c.sendStatus === "SCHEDULED" || c.sendStatus === "SENDING") && (
                <ConfirmDialog
                  trigger="Cancel campaign"
                  title="Cancel this campaign?"
                  description="Messages not yet sent are dropped. Sent messages can't be recalled."
                  confirmLabel="Cancel campaign"
                  formAction={cancelCampaignAction}
                  fields={{ campaignId: c.id }}
                />
              )}
          </div>
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7"
            data-testid="campaign-stats"
          >
            <StatCard label="Recipients" value={String(stats.total)} />
            <StatCard
              label="Waiting"
              value={String(stats.pending + stats.queued)}
            />
            <StatCard label="Sent" value={String(stats.sent)} />
            <StatCard label="Delivered" value={String(stats.delivered)} />
            <StatCard label="Read" value={String(stats.read)} />
            <StatCard
              label="Failed"
              value={String(stats.failed)}
              tone={stats.failed ? "danger" : "default"}
            />
            <StatCard
              label="Opted out since"
              value={String(stats.optedOut)}
              tone={stats.optedOut ? "warning" : "default"}
            />
          </div>
          {stats.skipReasons.length > 0 && (
            <Card className="mt-4">
              <CardTitle>Not sent</CardTitle>
              <ul className="mt-2 text-sm">
                {stats.skipReasons.map((r) => (
                  <li key={r.reason}>
                    {r.count} ·{" "}
                    {SKIP_REASONS[r.reason as keyof typeof SKIP_REASONS] ??
                      r.reason}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="mt-4 flex flex-col gap-2" data-testid="attribution">
            <CardTitle>
              What happened next (within {stats.attribution.days} days of their
              message)
            </CardTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Renewed / bought"
                value={String(stats.attribution.renewals)}
              />
              <StatCard
                label="Paid"
                value={String(stats.attribution.payers)}
                hint={
                  hasPermission(ctx, "reports.financial")
                    ? inr(stats.attribution.paidMinor)
                    : undefined
                }
              />
              <StatCard
                label="Leads who joined"
                value={String(stats.attribution.conversions)}
              />
              <StatCard
                label="Messages sent"
                value={String(stats.attribution.sent)}
              />
            </div>
            <p className="text-xs text-muted">
              Associated, not proof the message caused it: people may have
              renewed anyway.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
