import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getReconciliation } from "@gym/core/payments";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { PaymentsTabs } from "../payments-tabs";
import { resolveItemAction, runReconciliationAction } from "./actions";

export const metadata: Metadata = { title: "Reconciliation" };

const KIND = {
  QUICK: "Every 15 min",
  DAILY: "Nightly",
  MANUAL: "Run by staff",
} as const;

export default async function ReconciliationPage({
  searchParams,
}: PageProps<"/payments/reconciliation">) {
  const { ctx } = await requireReady("/payments/reconciliation");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const data = await getReconciliation(services().deps, ctx);
  const writable = isTenantWritable(ctx);
  const canResolve = writable && hasPermission(ctx, "billing.refund");
  const count = (s: string) =>
    data.webhooks.find((w) => w.status === s)?.count ?? 0;
  const last = data.runs[0];
  return (
    <>
      <PageHeader
        title="Payments"
        description="We compare our records with Razorpay every 15 minutes and every night, and fix missed updates on our own. Anything we can't fix shows here."
        actions={
          writable ? (
            <form action={runReconciliationAction}>
              <Button type="submit" variant="secondary">
                Check with Razorpay now
              </Button>
            </form>
          ) : undefined
        }
      />
      <PaymentsTabs current="/payments/reconciliation" />
      <Flash params={sp} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Needs a look"
          value={data.open.length}
          tone={data.open.length ? "warning" : "success"}
        />
        <StatCard
          label="Last check"
          value={last ? when(last.startedAt, ctx.timezone) : "Never"}
          hint={
            last ? `${last.checked} checked, ${last.fixed} fixed` : undefined
          }
        />
        <StatCard
          label="Updates received"
          value={count("PROCESSED") + count("IGNORED")}
        />
        <StatCard
          label="Updates failed"
          value={count("FAILED")}
          tone={count("FAILED") ? "danger" : "default"}
          hint={count("RECEIVED") ? `${count("RECEIVED")} waiting` : undefined}
        />
      </div>
      <h2 className="mb-2 text-base font-semibold">Needs a look</h2>
      <DataTable
        caption="Open reconciliation items"
        rows={data.open}
        rowKey={(i) => i.id}
        empty={
          <EmptyState
            title="All matched"
            description="Our records agree with Razorpay."
          />
        }
        columns={[
          {
            key: "issue",
            header: "What's wrong",
            cell: (i) => <span className="text-sm">{i.issue}</span>,
          },
          {
            key: "entity",
            header: "Record",
            hideOnMobile: true,
            cell: (i) => (
              <span className="text-xs text-muted">
                {i.entity.toLowerCase()}{" "}
                {i.providerId ?? i.entityId.slice(0, 8)}
              </span>
            ),
          },
          {
            key: "when",
            header: "Found",
            hideOnMobile: true,
            cell: (i) => when(i.createdAt, ctx.timezone),
          },
          {
            key: "actions",
            header: "",
            cell: (i) =>
              canResolve ? (
                <ConfirmDialog
                  trigger="Mark sorted"
                  title="Mark this as sorted?"
                  confirmLabel="Mark sorted"
                  formAction={resolveItemAction}
                  fields={{ itemId: i.id }}
                >
                  <FormField
                    label="What was done"
                    name="note"
                    required
                    minLength={3}
                  />
                </ConfirmDialog>
              ) : null,
          },
        ]}
      />
      <h2 className="mb-2 mt-8 text-base font-semibold">Recent checks</h2>
      <DataTable
        caption="Reconciliation runs"
        rows={data.runs}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No checks yet"
            description="The first one runs within 15 minutes."
          />
        }
        columns={[
          {
            key: "when",
            header: "Started",
            cell: (r) => when(r.startedAt, ctx.timezone),
          },
          {
            key: "kind",
            header: "Type",
            hideOnMobile: true,
            cell: (r) => KIND[r.kind],
          },
          { key: "checked", header: "Checked", cell: (r) => r.checked },
          { key: "fixed", header: "Fixed", cell: (r) => r.fixed },
          {
            key: "result",
            header: "Result",
            cell: (r) =>
              r.error ? (
                <Badge tone="danger">error</Badge>
              ) : !r.finishedAt ? (
                <Badge tone="info">running</Badge>
              ) : r.mismatches ? (
                <Badge tone="warning">{r.mismatches} to look at</Badge>
              ) : (
                <Badge tone="success">matched</Badge>
              ),
          },
        ]}
      />
    </>
  );
}
