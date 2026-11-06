import { hasPermission } from "@gym/core/authz";
import { getMyBilling } from "@gym/core/saas-billing";
import { getTenantOverview } from "@gym/core/tenancy";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day, inr, str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../settings-tabs";
import { cancelPlanAction, choosePlanAction } from "./actions";

export const metadata: Metadata = { title: "Plan & billing" };

const FEATURE_LABELS: Record<string, string> = {
  "classes.enabled": "Classes and bookings",
  "pt.enabled": "Personal training",
  "crm.enabled": "Leads and CRM",
  "online_payments.enabled": "Online payments",
  "whatsapp.enabled": "WhatsApp",
  "automation.enabled": "Automations",
  "workouts.enabled": "Workout programs",
  "nutrition.enabled": "Nutrition",
  "rewards.enabled": "Rewards and referrals",
  "reports.advanced": "Advanced reports",
  "ai.copilot": "AI copilot",
  "expenses.enabled": "Expenses",
  "pos.enabled": "Point of sale",
  "inventory.enabled": "Inventory",
};

const STATUS = {
  TRIALING: { label: "Free trial", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  PAST_DUE: { label: "Payment overdue", tone: "warning" },
  GRACE: { label: "Grace period", tone: "warning" },
  SUSPENDED: { label: "Suspended", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
} as const;

const CYCLES = [
  { value: "MONTHLY", label: "Monthly", per: "month" },
  { value: "HALF_YEARLY", label: "Every 6 months", per: "6 months" },
  { value: "YEARLY", label: "Yearly", per: "year" },
] as const;

export default async function PlanPage({
  searchParams,
}: PageProps<"/settings/plan">) {
  const { ctx } = await requireReady("/settings/plan");
  if (!hasPermission(ctx, "subscription.view")) return <NoAccess />;
  const sp = await searchParams;
  const deps = services().deps;
  const [overview, billing] = [
    await getTenantOverview(deps, ctx),
    await getMyBilling(deps, ctx),
  ];
  const canManage = hasPermission(ctx, "subscription.manage");
  const cycle =
    CYCLES.find((c) => c.value === str(sp.cycle))?.value ??
    billing.cycle ??
    "MONTHLY";
  const prices = billing.prices.filter((p) => p.cycle === cycle);
  const status = billing.status ? STATUS[billing.status] : null;
  const paying =
    billing.hasProviderSubscription && billing.status !== "CANCELLED";

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your plan, what it includes, and your bills from us."
      />
      <SettingsTabs current="/settings/plan" />
      <Flash params={sp} />

      {(billing.status === "PAST_DUE" || billing.status === "GRACE") && (
        <Alert
          tone="warning"
          title="Your last payment didn't go through"
          className="mb-4"
        >
          Razorpay will try again. To avoid interruption, check your card or UPI
          mandate
          {billing.graceEndsAt
            ? `. Changes turn off after ${when(billing.graceEndsAt, ctx.timezone)}`
            : ""}
          .
        </Alert>
      )}
      {billing.status === "SUSPENDED" && (
        <Alert tone="danger" title="Your gym is read-only" className="mb-4">
          Pick a plan below and pay to switch everything back on. Your data is
          safe.
        </Alert>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Plan"
          value={billing.plan?.name ?? "None"}
          hint={
            status ? (
              <Badge tone={status.tone}>{status.label}</Badge>
            ) : undefined
          }
        />
        <StatCard
          label={
            billing.status === "TRIALING"
              ? "Trial ends"
              : billing.cancelAtPeriodEnd
                ? "Ends on"
                : "Next bill"
          }
          value={
            billing.status === "TRIALING" && billing.trialEndsAt
              ? when(billing.trialEndsAt, ctx.timezone)
              : billing.currentPeriodEnd
                ? when(billing.currentPeriodEnd, ctx.timezone)
                : "—"
          }
          hint={
            billing.trialDaysLeft !== null
              ? `${billing.trialDaysLeft} day${billing.trialDaysLeft === 1 ? "" : "s"} left`
              : billing.amountMinor !== null
                ? inr(billing.amountMinor)
                : undefined
          }
        />
        {overview.usage.map((u) => (
          <StatCard
            key={u.key}
            label={
              u.key === "branches.max"
                ? "Branches"
                : u.key === "staff.max"
                  ? "Staff accounts"
                  : "Active members"
            }
            value={u.limit === null ? `${u.used}` : `${u.used} / ${u.limit}`}
            hint={u.limit === null ? "Unlimited" : undefined}
          />
        ))}
      </div>

      {billing.pendingPlan && (
        <Alert tone="info" className="mb-4">
          {billing.hasProviderSubscription && billing.status !== "TRIALING"
            ? `You move to ${billing.pendingPlan} at the end of this billing period.`
            : `Waiting for your first payment for ${billing.pendingPlan}.`}
        </Alert>
      )}
      {billing.cancelAtPeriodEnd && (
        <Alert tone="info" className="mb-4">
          Your subscription is cancelled and ends{" "}
          {billing.currentPeriodEnd
            ? when(billing.currentPeriodEnd, ctx.timezone)
            : "at the end of this period"}
          . Pick a plan to keep going.
        </Alert>
      )}

      <section aria-labelledby="plans" className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="plans" className="text-base font-semibold">
            Plans
          </h2>
          <nav aria-label="Billing cycle" className="flex gap-1 text-sm">
            {CYCLES.map((c) => (
              <a
                key={c.value}
                href={`/settings/plan?cycle=${c.value}`}
                aria-current={cycle === c.value ? "true" : undefined}
                className={`rounded-md border px-3 py-1.5 ${cycle === c.value ? "border-primary font-medium" : "border-border"}`}
              >
                {c.label}
              </a>
            ))}
          </nav>
        </div>
        {prices.length === 0 ? (
          <EmptyState
            title="No plans on sale"
            description="Contact support to change your plan."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {prices.map((p) => {
              const current =
                billing.plan?.id === p.plan.id &&
                billing.cycle === p.cycle &&
                billing.status !== "TRIALING";
              const per = CYCLES.find((c) => c.value === p.cycle)!.per;
              return (
                <Card
                  key={p.id}
                  className={current ? "border-primary" : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>{p.plan.name}</CardTitle>
                    {current && <Badge tone="success">Current</Badge>}
                  </div>
                  {p.plan.description && (
                    <CardDescription>{p.plan.description}</CardDescription>
                  )}
                  <p className="mt-3 text-2xl font-semibold">
                    {inr(p.amountMinor)}
                    <span className="ml-1 text-sm font-normal text-muted">
                      / {per}
                    </span>
                  </p>
                  {p.cycle !== "MONTHLY" && (
                    <p className="text-xs text-muted">
                      {inr(p.monthlyMinor)} a month
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted">Includes GST.</p>
                  {canManage && !current && (
                    <form action={choosePlanAction} className="mt-4">
                      <input type="hidden" name="priceId" value={p.id} />
                      <Button
                        type="submit"
                        className="w-full"
                        variant={paying ? "outline" : "primary"}
                      >
                        {paying
                          ? `Switch to ${p.plan.name}`
                          : `Choose ${p.plan.name}`}
                      </Button>
                    </form>
                  )}
                </Card>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Payments are taken by Razorpay as a recurring charge on your card or
          UPI mandate. Moving to a bigger plan takes effect now; moving to a
          smaller one takes effect at the end of the period.
        </p>
        {canManage && paying && !billing.cancelAtPeriodEnd && (
          <div className="mt-4">
            <ConfirmDialog
              trigger="Cancel subscription"
              title="Cancel your subscription?"
              confirmLabel="Cancel subscription"
              formAction={cancelPlanAction}
            >
              <p className="text-sm">
                Everything keeps working until the end of this billing period.
                After that the gym becomes read-only: your data stays safe and
                you can subscribe again at any time.
              </p>
            </ConfirmDialog>
          </div>
        )}
      </section>

      <h2 className="mb-3 text-base font-semibold">Bills from us</h2>
      <DataTable
        caption="Subscription invoices"
        rows={billing.invoices}
        rowKey={(i) => i.id}
        empty={
          <EmptyState
            title="No bills yet"
            description="Your first bill appears after your first payment."
          />
        }
        columns={[
          { key: "number", header: "Invoice", cell: (i) => i.number },
          { key: "date", header: "Date", cell: (i) => day(i.issueDate) },
          {
            key: "for",
            header: "For",
            hideOnMobile: true,
            cell: (i) => i.description,
          },
          {
            key: "tax",
            header: "GST",
            hideOnMobile: true,
            cell: (i) => inr(i.taxMinor),
          },
          { key: "total", header: "Total", cell: (i) => inr(i.totalMinor) },
          {
            key: "status",
            header: "Status",
            cell: (i) => (
              <Badge tone={i.status === "PAID" ? "success" : "neutral"}>
                {i.status.toLowerCase()}
              </Badge>
            ),
          },
        ]}
      />

      <h2 className="mb-3 mt-8 text-base font-semibold">
        Features on your plan
      </h2>
      <DataTable
        caption="Features on your plan"
        rows={overview.features}
        rowKey={(f) => f.key}
        columns={[
          {
            key: "feature",
            header: "Feature",
            cell: (f) => FEATURE_LABELS[f.key] ?? f.key,
          },
          {
            key: "included",
            header: "Included",
            cell: (f) =>
              f.enabled ? (
                <Badge tone="success">Included</Badge>
              ) : (
                <Badge tone="neutral">Not included</Badge>
              ),
          },
        ]}
      />
    </>
  );
}
