import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listPayments } from "@gym/core/billing";
import { startOfDayUtc } from "@gym/core/time/dates";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  Pagination,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr, str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { voidPaymentAction } from "../members/actions";
import { PaymentsTabs } from "./payments-tabs";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage({
  searchParams,
}: PageProps<"/payments">) {
  const { ctx } = await requireReady("/payments");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const from = str(sp.from);
  const to = str(sp.to);
  const page = str(sp.page) ?? "1";
  const result = await listPayments(services().deps, ctx, {
    from: from ? startOfDayUtc(from, ctx.timezone).toISOString() : undefined,
    to: to ? startOfDayUtc(to, ctx.timezone).toISOString() : undefined,
    branchId: str(sp.branchId),
    page,
  });
  const canVoid = isTenantWritable(ctx) && hasPermission(ctx, "billing.void");
  const canRefund =
    isTenantWritable(ctx) && hasPermission(ctx, "billing.refund");
  const q = (p: number) =>
    `/payments?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), page: String(p) })}`;
  return (
    <>
      <PageHeader
        title="Payments"
        description={
          from ? `${from} to ${to ?? "now"}` : "All recorded payments"
        }
      />
      <PaymentsTabs current="/payments" />
      <Flash params={sp} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          From
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="h-10 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          To (not included)
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="h-10 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <button
          type="submit"
          className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium"
        >
          Filter
        </button>
      </form>
      <DataTable
        caption="Payments"
        rows={result.rows}
        rowKey={(p) => p.id}
        empty={<EmptyState title="No payments in this period" />}
        columns={[
          { key: "receipt", header: "Receipt", cell: (p) => p.receiptNumber },
          {
            key: "member",
            header: "Member",
            cell: (p) => (
              <a
                className="text-primary underline"
                href={`/members/${p.memberId}?tab=billing`}
              >
                {p.member.firstName} {p.member.lastName ?? ""}
              </a>
            ),
          },
          {
            key: "when",
            header: "Received",
            hideOnMobile: true,
            cell: (p) => when(p.receivedAt, ctx.timezone),
          },
          { key: "amount", header: "Amount", cell: (p) => inr(p.amountMinor) },
          {
            key: "method",
            header: "Method",
            hideOnMobile: true,
            cell: (p) => p.method.replace("_", " ").toLowerCase(),
          },
          {
            key: "for",
            header: "Applied to",
            hideOnMobile: true,
            cell: (p) =>
              p.allocations.map((a) => a.invoice.number).join(", ") || "Credit",
          },
          {
            key: "status",
            header: "Status",
            cell: (p) =>
              p.status === "VOID" ? (
                <Badge tone="danger">Void</Badge>
              ) : (
                <Badge tone="success">OK</Badge>
              ),
          },
          {
            key: "void",
            header: "",
            cell: (p) =>
              p.status === "SUCCEEDED" && canRefund ? (
                <span className="flex gap-1">
                  <a
                    className="text-sm text-primary underline"
                    href={`/payments/${p.id}/refund`}
                  >
                    Refund
                  </a>
                  {canVoid && p.method !== "ONLINE" && (
                    <ConfirmDialog
                      trigger="Void"
                      title={`Void receipt ${p.receiptNumber}?`}
                      confirmLabel="Void payment"
                      formAction={voidPaymentAction}
                      fields={{ paymentId: p.id, back: "/payments" }}
                    >
                      <FormField label="Reason" name="reason" required />
                    </ConfirmDialog>
                  )}
                </span>
              ) : canVoid &&
                p.status === "SUCCEEDED" &&
                p.method !== "ONLINE" ? (
                <ConfirmDialog
                  trigger="Void"
                  title={`Void receipt ${p.receiptNumber}?`}
                  confirmLabel="Void payment"
                  formAction={voidPaymentAction}
                  fields={{ paymentId: p.id, back: "/payments" }}
                >
                  <FormField label="Reason" name="reason" required />
                </ConfirmDialog>
              ) : null,
          },
        ]}
      />
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        hrefFor={q}
      />
    </>
  );
}
