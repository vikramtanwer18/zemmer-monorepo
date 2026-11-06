import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listTemplates } from "@gym/core/messaging";
import {
  RETENTION_KINDS,
  RETENTION_RULES,
  retentionDashboard,
} from "@gym/core/retention";
import {
  Badge,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  StatCard,
  Tabs,
  Button,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { TemplateSender } from "@/components/template-sender";
import { inr, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { dismissFlagAction, taskForFlagAction } from "./actions";

export const metadata: Metadata = { title: "Retention" };

export default async function RetentionPage({
  searchParams,
}: PageProps<"/retention">) {
  const { ctx } = await requireReady("/retention");
  if (!hasPermission(ctx, "retention.view")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const kind = typeof sp.kind === "string" ? sp.kind : "";
  const status = typeof sp.status === "string" ? sp.status : "OPEN";
  const data = await retentionDashboard(deps, ctx, { kind, status });
  const canMessage = hasPermission(ctx, "messaging.send");
  const templates = canMessage
    ? await listTemplates(deps, ctx, { approvedOnly: true }).catch(() => [])
    : [];
  const openFlag = typeof sp.flag === "string" ? sp.flag : null;
  const canAct = isTenantWritable(ctx);
  const r = data.recovery;
  const qs = (extra: Record<string, string>) =>
    `/retention?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(status !== "OPEN" ? { status } : {}), ...extra })}`;
  return (
    <>
      <PageHeader
        title="Retention"
        description="Who needs attention, and why. Flags come from your rules every night; each says which rule fired."
        actions={
          hasPermission(ctx, "settings.manage") ? (
            <LinkButton href="/retention/rules" variant="outline">
              Rules
            </LinkButton>
          ) : null
        }
      />
      <Flash params={sp} />
      <section aria-labelledby="recovery" className="mb-6">
        <h2 id="recovery" className="mb-2 text-sm font-semibold text-muted">
          Last {r.days} days (associated with a flag or automation, not proof of
          cause)
        </h2>
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
          data-testid="recovery"
        >
          <StatCard label="Flagged" value={String(r.flagged)} />
          <StatCard
            label="Recovered after a flag"
            value={String(r.recoveredFromFlags)}
          />
          <StatCard
            label="Renewals"
            value={String(r.renewals)}
            hint={
              hasPermission(ctx, "reports.financial")
                ? inr(r.renewalValueMinor)
                : undefined
            }
          />
          <StatCard
            label="Overdue recovered"
            value={
              hasPermission(ctx, "reports.financial")
                ? inr(r.overdueRecoveredMinor)
                : "—"
            }
          />
          <StatCard label="Came back" value={String(r.reactivated)} />
          <StatCard
            label="Leads converted"
            value={String(r.conversions)}
            hint={`${r.fromAutomations} after an automation`}
          />
        </div>
      </section>
      <Tabs
        label="Flags by reason"
        current={qs({})}
        items={[
          {
            href:
              status !== "OPEN" ? `/retention?status=${status}` : "/retention",
            label: `All (${Object.values(data.counts).reduce((a, b) => a + b, 0)})`,
          },
          ...RETENTION_KINDS.map((k) => ({
            href: `/retention?${new URLSearchParams({ kind: k, ...(status !== "OPEN" ? { status } : {}) })}`,
            label: `${RETENTION_RULES[k].label} (${data.counts[k]})`,
          })),
        ]}
      />
      <div className="mb-3 flex gap-3 text-sm">
        {["OPEN", "RESOLVED", "DISMISSED"].map((s) => (
          <a
            key={s}
            href={`/retention?${new URLSearchParams({ ...(kind ? { kind } : {}), status: s })}`}
            className={
              s === status ? "font-semibold" : "text-primary underline"
            }
          >
            {s === "OPEN"
              ? "Open"
              : s === "RESOLVED"
                ? "Resolved"
                : "Dismissed"}
          </a>
        ))}
      </div>
      <DataTable
        caption="Retention flags"
        rows={data.rows}
        rowKey={(f) => f.id}
        empty={
          <EmptyState
            title="Nobody flagged"
            description={
              status === "OPEN"
                ? "Everyone looks fine by your rules. Flags are worked out every night."
                : "Nothing here."
            }
          />
        }
        columns={[
          {
            key: "who",
            header: "Who",
            cell: (f) => (
              <span className="flex flex-col">
                {f.memberId ? (
                  <a
                    className="font-medium text-primary underline"
                    href={`/members/${f.memberId}`}
                  >
                    {f.name}
                  </a>
                ) : f.leadId ? (
                  <a
                    className="font-medium text-primary underline"
                    href={`/leads/${f.leadId}`}
                  >
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
                <span className="text-xs text-muted">
                  {f.phone ?? "no mobile"}
                </span>
              </span>
            ),
          },
          {
            key: "why",
            header: "Why",
            cell: (f) => (
              <span className="flex flex-col gap-1">
                <Badge tone="warning" className="self-start">
                  {
                    RETENTION_RULES[f.kind as keyof typeof RETENTION_RULES]
                      .label
                  }
                </Badge>
                <span className="text-sm">{f.reason}</span>
              </span>
            ),
          },
          {
            key: "next",
            header: "Suggested next step",
            hideOnMobile: true,
            cell: (f) => (
              <span className="text-sm">
                {f.action ? (
                  <Badge tone="info">{f.action}</Badge>
                ) : (
                  (f.outcome ?? f.recommended)
                )}
              </span>
            ),
          },
          {
            key: "since",
            header: "Flagged",
            hideOnMobile: true,
            cell: (f) => when(f.createdAt, ctx.timezone),
          },
          {
            key: "act",
            header: "",
            cell: (f) =>
              canAct && (f.status === "OPEN" || f.status === "ACTIONED") ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    {hasPermission(ctx, "tasks.manage") && (
                      <form action={taskForFlagAction}>
                        <input type="hidden" name="flagId" value={f.id} />
                        <Button type="submit" size="sm" variant="outline">
                          Create task
                        </Button>
                      </form>
                    )}
                    {canMessage && f.hasPhone && openFlag !== f.id && (
                      <LinkButton
                        href={qs({ flag: f.id })}
                        size="sm"
                        variant="outline"
                      >
                        Send template
                      </LinkButton>
                    )}
                    <ConfirmDialog
                      trigger="Dismiss"
                      triggerVariant="ghost"
                      title="Dismiss this flag?"
                      description="It won't come back while the rule keeps firing for them."
                      confirmLabel="Dismiss"
                      formAction={dismissFlagAction}
                      fields={{ flagId: f.id }}
                    >
                      <label className="flex flex-col gap-1.5 text-sm font-medium">
                        Why
                        <input
                          name="reason"
                          required
                          minLength={3}
                          className="h-10 rounded-md border border-border bg-surface px-3"
                        />
                      </label>
                    </ConfirmDialog>
                  </div>
                  {openFlag === f.id && (
                    <Card>
                      <CardTitle>Template to {f.name}</CardTitle>
                      <TemplateSender
                        templates={templates}
                        chosenId={
                          typeof sp.template === "string" ? sp.template : null
                        }
                        back={qs({})}
                        subject={
                          f.memberId
                            ? { memberId: f.memberId }
                            : { leadId: f.leadId! }
                        }
                        flagId={f.id}
                        extraParams={{ ...(kind ? { kind } : {}), flag: f.id }}
                      />
                    </Card>
                  )}
                </div>
              ) : null,
          },
        ]}
      />
    </>
  );
}
