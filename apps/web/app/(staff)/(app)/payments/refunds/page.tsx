import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listRefunds } from "@gym/core/payments";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr, str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { PaymentsTabs } from "../payments-tabs";
import { approveRefundAction, rejectRefundAction } from "./actions";

export const metadata: Metadata = { title: "Refunds" };

const TONE = {
  PENDING_APPROVAL: "warning",
  PENDING: "info",
  PROCESSED: "success",
  FAILED: "danger",
  REJECTED: "neutral",
} as const;
const LABEL = {
  PENDING_APPROVAL: "needs approval",
  PENDING: "processing",
  PROCESSED: "refunded",
  FAILED: "failed",
  REJECTED: "rejected",
} as const;

const FILTERS = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Needs approval" },
  { value: "pending", label: "Processing" },
] as const;

export default async function RefundsPage({
  searchParams,
}: PageProps<"/payments/refunds">) {
  const { ctx } = await requireReady("/payments/refunds");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const status =
    FILTERS.find((f) => f.value === str(sp.status))?.value ?? "all";
  const refunds = await listRefunds(services().deps, ctx, { status });
  const writable = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Payments"
        description="Refunds go back through Razorpay for online payments, or by hand for cash and other methods. Each one is backed by a credit note."
      />
      <PaymentsTabs current="/payments/refunds" />
      <Flash params={sp} />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <a
            key={f.value}
            className={`rounded-md border px-3 py-1.5 ${status === f.value ? "border-primary" : "border-border"}`}
            href={
              f.value === "all"
                ? "/payments/refunds"
                : `/payments/refunds?status=${f.value}`
            }
          >
            {f.label}
          </a>
        ))}
      </div>
      <DataTable
        caption="Refunds"
        rows={refunds}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No refunds"
            description="Start a refund from the Payments tab, next to the payment."
          />
        }
        columns={[
          {
            key: "member",
            header: "Member",
            cell: (r) => (
              <a
                className="font-medium text-primary underline"
                href={`/members/${r.member.id}?tab=billing`}
              >
                {r.member.name}
              </a>
            ),
          },
          { key: "amount", header: "Amount", cell: (r) => inr(r.amountMinor) },
          {
            key: "how",
            header: "How",
            hideOnMobile: true,
            cell: (r) =>
              r.kind === "ONLINE"
                ? `Razorpay · receipt ${r.receiptNumber}`
                : `${(r.method ?? "").replace("_", " ").toLowerCase()} · receipt ${r.receiptNumber}`,
          },
          {
            key: "reason",
            header: "Reason",
            hideOnMobile: true,
            cell: (r) => (
              <span className="text-sm">
                {r.reason}
                {r.failureReason && (
                  <span className="block text-xs text-danger">
                    {r.failureReason}
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "when",
            header: "Asked",
            hideOnMobile: true,
            cell: (r) => when(r.createdAt, ctx.timezone),
          },
          {
            key: "status",
            header: "Status",
            cell: (r) => <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>,
          },
          {
            key: "actions",
            header: "",
            cell: (r) =>
              writable && r.canDecide ? (
                <span className="flex flex-wrap gap-1">
                  <form action={approveRefundAction}>
                    <input type="hidden" name="refundId" value={r.id} />
                    <Button type="submit" size="sm">
                      Approve
                    </Button>
                  </form>
                  <ConfirmDialog
                    trigger="Reject"
                    title={`Reject the ${inr(r.amountMinor)} refund?`}
                    confirmLabel="Reject refund"
                    formAction={rejectRefundAction}
                    fields={{ refundId: r.id }}
                  >
                    <FormField
                      label="Reason"
                      name="reason"
                      required
                      minLength={3}
                    />
                  </ConfirmDialog>
                </span>
              ) : r.status === "PENDING_APPROVAL" && r.requestedByMe ? (
                <span className="text-xs text-muted">
                  Waiting for someone else to approve
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}
