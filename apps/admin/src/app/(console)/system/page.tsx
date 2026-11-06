import { outboxHealth, systemHealth } from "@gym/core/saas-billing";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { at } from "@/lib/format";
import { Notices } from "@/lib/notices";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { retryJobAction, retryOutboxAction } from "../billing/actions";

export const metadata: Metadata = { title: "System health" };

export default async function SystemPage({
  searchParams,
}: PageProps<"/system">) {
  const { ctx } = await requireAdmin("/system");
  if (!ctx.permissions.has("platform.system.view"))
    return (
      <EmptyState
        title="No access"
        description="Ask a Super Admin for access."
      />
    );
  const sp = await searchParams;
  const h = await systemHealth(services().db, services().redis, ctx);
  const outbox = await outboxHealth(services().db, ctx);
  const canRetry = ctx.permissions.has("platform.billing.manage");
  const failedPlatform =
    h.platformWebhooks.find((w) => w.status === "FAILED")?.count ?? 0;
  return (
    <>
      <PageHeader
        title="System health"
        description={`Checked ${at(h.checkedAt)}. Reload to refresh.`}
      />
      <Notices sp={sp} />
      <h2 className="mb-2 text-base font-semibold">
        Webhooks (since the counters were last reset)
      </h2>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          label="Gym webhooks received"
          value={h.metrics.webhook_received}
        />
        <StatCard
          label="Gym webhooks rejected"
          value={h.metrics.webhook_rejected}
          tone={h.metrics.webhook_rejected ? "warning" : "default"}
          hint="Bad signature or unknown account"
        />
        <StatCard
          label="Platform webhooks received"
          value={h.metrics.platform_webhook_received}
        />
        <StatCard
          label="Platform webhooks rejected"
          value={h.metrics.platform_webhook_rejected}
          tone={h.metrics.platform_webhook_rejected ? "warning" : "default"}
        />
        <StatCard
          label="Platform webhooks failed"
          value={failedPlatform}
          tone={failedPlatform ? "danger" : "default"}
          hint="Replayed hourly"
        />
      </div>
      <h2 className="mb-2 text-base font-semibold">
        Outbox (events and emails waiting to be sent on)
      </h2>
      <div
        className="mb-3 flex flex-wrap gap-2 text-sm"
        data-testid="outbox-stats"
      >
        {outbox.stats.length === 0 ? (
          <Badge tone="success">Nothing waiting</Badge>
        ) : (
          outbox.stats.map((s) => (
            <Badge
              key={`${s.status}-${s.topic}`}
              tone={s.status === "FAILED" ? "danger" : "info"}
            >
              {s.topic} · {s.status.toLowerCase()} · {s.count}
            </Badge>
          ))
        )}
      </div>
      {outbox.deadLetters.length > 0 && (
        <Card className="mb-6">
          <CardTitle>Dead letters</CardTitle>
          <p className="mt-1 text-sm text-muted">
            Gave up after 10 tries. Fix the cause, then retry. Contents are not
            shown (ids only).
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {outbox.deadLetters.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-2"
              >
                <span>
                  <span className="font-medium">{d.topic}</span> ·{" "}
                  {d.tenantName}
                  <span className="block text-xs text-muted">
                    {at(d.createdAt)} · {d.attempts} tries · {d.id.slice(0, 8)}
                  </span>
                  {d.lastError && (
                    <span className="block break-words font-mono text-xs text-danger">
                      {d.lastError}
                    </span>
                  )}
                </span>
                {canRetry && (
                  <form action={retryOutboxAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Retry
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <h2 className="mb-2 text-base font-semibold">Job queues</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {h.queues.map((q) => (
          <Card key={q.name}>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>{q.name}</CardTitle>
              {q.counts.failed ? (
                <Badge tone="danger">{q.counts.failed} failed</Badge>
              ) : (
                <Badge tone="success">ok</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {q.counts.waiting ?? 0} waiting · {q.counts.active ?? 0} running ·{" "}
              {q.counts.delayed ?? 0} scheduled · {q.counts.completed ?? 0} done
              (kept)
            </p>
            {q.failed.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {q.failed.map((j) => (
                  <li
                    key={j.id}
                    className="rounded-md border border-border p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span>
                        <span className="font-medium">{j.name}</span>
                        <span className="block text-xs text-muted">
                          {at(j.failedAt)} · {j.attempts} tries · id{" "}
                          {j.id.slice(0, 24)}
                        </span>
                      </span>
                      {canRetry && (
                        <form action={retryJobAction}>
                          <input type="hidden" name="queue" value={q.name} />
                          <input type="hidden" name="jobId" value={j.id} />
                          <Button type="submit" size="sm" variant="outline">
                            Retry
                          </Button>
                        </form>
                      )}
                    </div>
                    {j.reason && (
                      <p className="mt-1 break-words font-mono text-xs text-danger">
                        {j.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
