import { hasPermission } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import {
  getSegment,
  previewSegment,
  segmentBuilderOptions,
} from "@gym/core/growth";
import { Alert, Button, Card, CardTitle, PageHeader, StatCard } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { definitionFromParams, paramsFromDefinition } from "@/lib/segment-form";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { saveSegmentAction } from "../../actions";
import { CampaignsTabs } from "../../campaigns-tabs";

export const metadata: Metadata = { title: "Audience" };

const input = "h-10 rounded-md border border-border bg-surface px-3 text-sm";

function Multi({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: { id: string; name: string }[];
  value: string[];
}) {
  if (!options.length) return null;
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="font-medium">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              name={name}
              value={o.id}
              defaultChecked={value.includes(o.id)}
            />
            {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Num({
  name,
  label,
  value,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input
        name={name}
        type="number"
        min={0}
        max={3650}
        defaultValue={value}
        className={input}
      />
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

export default async function AudienceEditPage({
  searchParams,
}: PageProps<"/campaigns/audiences/edit">) {
  const { ctx } = await requireReady("/campaigns/audiences/edit");
  if (!hasPermission(ctx, "marketing.send")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const options = await orUpgrade(segmentBuilderOptions(deps, ctx));
  if (!options)
    return <UpgradeNotice title="Audiences" feature="WhatsApp campaigns" />;
  const segmentId = typeof sp.segmentId === "string" ? sp.segmentId : "";
  const fromForm = "entity" in sp;
  const saved =
    segmentId && !fromForm ? await getSegment(deps, ctx, segmentId) : null;
  const p: Record<string, string | string[] | undefined> = saved
    ? { ...paramsFromDefinition(saved.definition), name: saved.name }
    : sp;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const l = (k: string) =>
    Array.isArray(p[k]) ? (p[k] as string[]) : p[k] ? [p[k] as string] : [];
  const entity = s("entity") === "LEAD" ? "LEAD" : "MEMBER";
  let preview: Awaited<ReturnType<typeof previewSegment>> | null = null;
  let previewError: string | null = null;
  if (fromForm || saved) {
    try {
      preview = await previewSegment(deps, ctx, definitionFromParams(p));
    } catch (err) {
      if (!isAppError(err)) throw err;
      previewError = err.message;
    }
  }
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Pick who should get it. Only people with a mobile number count; promotional templates also need their WhatsApp marketing consent."
      />
      <CampaignsTabs current="/campaigns/audiences" />
      <Flash params={sp} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <form method="get" className="flex flex-col gap-4">
          <input type="hidden" name="segmentId" value={segmentId} />
          <Card className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Name
              <input
                name="name"
                defaultValue={s("name")}
                placeholder="Expiring this week"
                className={input}
              />
            </label>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex flex-col gap-1 font-medium">
                People
                <select name="entity" defaultValue={entity} className={input}>
                  <option value="MEMBER">Members</option>
                  <option value="LEAD">Leads</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 font-medium">
                Match
                <select
                  name="match"
                  defaultValue={s("match") || "ALL"}
                  className={input}
                >
                  <option value="ALL">All of the conditions</option>
                  <option value="ANY">Any of the conditions</option>
                </select>
              </label>
            </div>
            <p className="text-xs text-muted">
              Changed People? Press Preview to see the right filters.
            </p>
          </Card>
          {entity === "MEMBER" ? (
            <Card className="flex flex-col gap-4">
              <CardTitle>Members who…</CardTitle>
              <fieldset className="flex flex-col gap-1 text-sm">
                <legend className="font-medium">Status</legend>
                <div className="flex gap-4">
                  {[
                    ["ACTIVE", "Active"],
                    ["PENDING_APPROVAL", "Waiting for approval"],
                  ].map(([v, label]) => (
                    <label key={v} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        name="status"
                        value={v}
                        defaultChecked={l("status").includes(v!)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Multi
                name="branch"
                label="Home branch"
                options={options.branches}
                value={l("branch")}
              />
              <Multi
                name="plan"
                label="On plan (current membership)"
                options={options.plans}
                value={l("plan")}
              />
              <label className="flex flex-col gap-1 text-sm font-medium">
                Membership
                <select
                  name="membership"
                  defaultValue={s("membership")}
                  className={input}
                >
                  <option value="">Any</option>
                  <option value="CURRENT">Has a current membership</option>
                  <option value="LAPSED">
                    Lapsed (ended, nothing current)
                  </option>
                  <option value="NEVER">Never had one</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <Num
                  name="expiresMin"
                  label="Membership ends in at least (days)"
                  value={s("expiresMin")}
                />
                <Num
                  name="expiresMax"
                  label="…and at most (days)"
                  value={s("expiresMax")}
                />
                <Num
                  name="expiredMin"
                  label="Ended at least (days ago)"
                  value={s("expiredMin")}
                />
                <Num
                  name="expiredMax"
                  label="…and at most (days ago)"
                  value={s("expiredMax")}
                />
                <Num
                  name="noVisitDays"
                  label="No visit in the last (days)"
                  value={s("noVisitDays")}
                />
                <Num
                  name="visitedWithin"
                  label="Visited in the last (days)"
                  value={s("visitedWithin")}
                />
                <Num
                  name="joinedWithin"
                  label="Joined in the last (days)"
                  value={s("joinedWithin")}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Tagged (any of)
                  <input
                    name="tagsAny"
                    defaultValue={s("tagsAny")}
                    placeholder="vip, morning"
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Not tagged
                  <input
                    name="tagsNone"
                    defaultValue={s("tagsNone")}
                    className={input}
                  />
                </label>
              </div>
            </Card>
          ) : (
            <Card className="flex flex-col gap-4">
              <CardTitle>Leads who…</CardTitle>
              <Multi
                name="stage"
                label="Are in stage"
                options={options.stages}
                value={l("stage")}
              />
              <Multi
                name="leadStatus"
                label="Status"
                options={[
                  { id: "OPEN", name: "Open" },
                  { id: "WON", name: "Won" },
                  { id: "LOST", name: "Lost" },
                ]}
                value={l("leadStatus")}
              />
              <Multi
                name="branch"
                label="Branch"
                options={options.branches}
                value={l("branch")}
              />
              <Multi
                name="source"
                label="Source"
                options={options.sources}
                value={l("source")}
              />
              <Multi
                name="campaign"
                label="Campaign"
                options={options.campaigns}
                value={l("campaign")}
              />
              <Num
                name="createdWithin"
                label="Enquired in the last (days)"
                value={s("createdWithin")}
              />
            </Card>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="outline">
              Preview
            </Button>
            <Button
              type="submit"
              formAction={saveSegmentAction}
              formMethod="post"
            >
              Save audience
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-3" data-testid="segment-preview">
          {previewError && <Alert tone="danger">{previewError}</Alert>}
          {preview ? (
            <>
              <p className="text-sm text-muted">{preview.summary}</p>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Match now" value={String(preview.count)} />
                <StatCard
                  label="Can get promotions"
                  value={`${preview.estimated ? "~" : ""}${preview.marketingReachable}`}
                />
                <StatCard
                  label="Opted out"
                  value={String(preview.suppressed)}
                />
                <StatCard
                  label="Can get reminders"
                  value={`${preview.estimated ? "~" : ""}${preview.serviceReachable}`}
                />
              </div>
              {preview.capped && (
                <Alert tone="warning">
                  Capped at 50,000 people; narrow the filters.
                </Alert>
              )}
              <Card>
                <CardTitle>A few of them</CardTitle>
                <ul className="mt-2 text-sm">
                  {preview.sample.map((x, i) => (
                    <li key={i}>
                      {x.name} <span className="text-muted">{x.phone}</span>
                    </li>
                  ))}
                  {!preview.sample.length && (
                    <li className="text-muted">Nobody matches.</li>
                  )}
                </ul>
              </Card>
            </>
          ) : (
            <p className="text-sm text-muted">
              Set filters and press Preview to see how many people match.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
