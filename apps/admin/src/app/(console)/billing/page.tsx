import { billingOverview } from "@gym/core/saas-billing";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  LinkButton,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { at, inr, onDay } from "@/lib/format";
import { Notices } from "@/lib/notices";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { compAction, extendTrialAction } from "./actions";

export const metadata: Metadata = { title: "Billing" };

const TONE = {
  TRIALING: "info",
  ACTIVE: "success",
  PAST_DUE: "warning",
  GRACE: "warning",
  SUSPENDED: "danger",
  CANCELLED: "neutral",
} as const;

const CYCLE = {
  MONTHLY: "monthly",
  HALF_YEARLY: "6-monthly",
  YEARLY: "yearly",
} as const;

export default async function BillingPage({
  searchParams,
}: PageProps<"/billing">) {
  const { ctx } = await requireAdmin("/billing");
  if (!ctx.permissions.has("platform.billing.view"))
    return (
      <EmptyState
        title="No access"
        description="Ask a Super Admin for billing access."
      />
    );
  const sp = await searchParams;
  const o = await billingOverview(services().billing, ctx);
  const canManage = ctx.permissions.has("platform.billing.manage");
  return (
    <>
      <PageHeader
        title="Billing"
        description="Gym subscriptions paid to the platform through Razorpay. MRR counts paying subscriptions only (see KPI definitions)."
        actions={
          canManage ? (
            <LinkButton href="/billing/setup" variant="outline">
              Payment account and prices
            </LinkButton>
          ) : undefined
        }
      />
      <Notices sp={sp} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="MRR" value={o.formatted.mrr} />
        <StatCard label="ARR" value={o.formatted.arr} hint="MRR × 12" />
        <StatCard
          label="Paying"
          value={o.counts.ACTIVE ?? 0}
          hint={`${o.counts.TRIALING ?? 0} on trial`}
        />
        <StatCard
          label="Payment problems"
          value={
            (o.counts.PAST_DUE ?? 0) +
            (o.counts.GRACE ?? 0) +
            (o.counts.SUSPENDED ?? 0)
          }
          tone={o.pastDue.length ? "warning" : "default"}
          hint={`${o.counts.SUSPENDED ?? 0} suspended`}
        />
      </div>
      <DataTable
        caption="Subscriptions"
        rows={o.subscriptions}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No subscriptions yet" />}
        columns={[
          {
            key: "tenant",
            header: "Gym",
            cell: (s) => (
              <a
                className="font-medium text-primary underline"
                href={`/tenants/${s.tenant.id}`}
              >
                {s.tenant.displayName}
              </a>
            ),
          },
          {
            key: "plan",
            header: "Plan",
            cell: (s) => (
              <span>
                {s.plan}
                {s.cycle && (
                  <span className="block text-xs text-muted">
                    {inr(s.amountMinor)} {CYCLE[s.cycle]}
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (s) => (
              <span className="flex flex-wrap gap-1">
                <Badge tone={TONE[s.status]}>
                  {s.status.replace("_", " ").toLowerCase()}
                </Badge>
                {s.cancelAtPeriodEnd && <Badge tone="neutral">ends</Badge>}
                {!s.provider && s.status === "ACTIVE" && (
                  <Badge tone="info">comp</Badge>
                )}
              </span>
            ),
          },
          {
            key: "dates",
            header: "Trial / period ends",
            hideOnMobile: true,
            cell: (s) =>
              s.status === "TRIALING"
                ? at(s.trialEndsAt)
                : onDay(s.currentPeriodEnd),
          },
          {
            key: "actions",
            header: "",
            cell: (s) =>
              canManage ? (
                <span className="flex flex-wrap gap-1">
                  {!s.provider &&
                    ["TRIALING", "SUSPENDED", "PAST_DUE", "GRACE"].includes(
                      s.status,
                    ) && (
                      <ConfirmDialog
                        trigger="Extend trial"
                        title={`Extend ${s.tenant.displayName}'s trial?`}
                        confirmLabel="Extend"
                        confirmVariant="primary"
                        formAction={extendTrialAction}
                        fields={{ tenantId: s.tenant.id }}
                      >
                        <FormField
                          label="Days"
                          name="days"
                          type="number"
                          min={1}
                          max={365}
                          defaultValue={14}
                          required
                        />
                        <FormField
                          label="Reason"
                          name="reason"
                          required
                          minLength={5}
                        />
                      </ConfirmDialog>
                    )}
                  <ConfirmDialog
                    trigger="Free access"
                    title={`Give ${s.tenant.displayName} free access?`}
                    description="Active without payment until the date, then it ends unless they subscribe."
                    confirmLabel="Give free access"
                    confirmVariant="primary"
                    formAction={compAction}
                    fields={{ tenantId: s.tenant.id }}
                  >
                    <FormField
                      label="Until (inclusive)"
                      name="until"
                      type="date"
                      required
                    />
                    <FormField
                      label="Reason"
                      name="reason"
                      required
                      minLength={5}
                    />
                  </ConfirmDialog>
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}
