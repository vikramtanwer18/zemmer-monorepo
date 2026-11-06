import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getInvoice } from "@gym/core/billing";
import { isAppError } from "@gym/core/errors";
import { memberName } from "@gym/core/members";
import {
  Breadcrumbs,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  FormField,
  LinkButton,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day, inr, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { creditNoteAction, voidInvoiceAction } from "../../members/actions";
import { InvoiceBadge } from "@/components/invoice-badge";
import { OnlinePaymentPanel } from "./online-payment";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage({
  params,
  searchParams,
}: PageProps<"/invoices/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/invoices/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await getInvoice(services().deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    if (isAppError(err) && err.code === "FORBIDDEN") return null;
    throw err;
  });
  if (!result) return <NoAccess />;
  const { invoice, balance } = result;
  const supplier = invoice.supplier as Record<string, string | null>;
  const writable = isTenantWritable(ctx);
  const canVoid =
    writable &&
    hasPermission(ctx, "billing.void", { branchId: invoice.branchId }) &&
    balance.allocatedMinor === 0 &&
    balance.creditedMinor === 0 &&
    !invoice.voidedAt;
  const canCredit =
    writable &&
    hasPermission(ctx, "billing.refund", { branchId: invoice.branchId }) &&
    !invoice.voidedAt &&
    balance.totalMinor > balance.creditedMinor;
  const isTax = invoice.documentType === "TAX_INVOICE";

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Invoices", href: "/invoices" },
          {
            label: memberName(invoice.member),
            href: `/members/${invoice.memberId}?tab=billing`,
          },
          { label: invoice.number },
        ]}
      />
      <PageHeader
        title={`${isTax ? "Tax invoice" : "Bill"} ${invoice.number}`}
        description={
          <span className="flex items-center gap-2">
            {day(invoice.issueDate)} · <InvoiceBadge status={invoice.status} />
          </span>
        }
        actions={
          <>
            <LinkButton
              href={`/api/invoices/${invoice.id}/pdf`}
              variant="outline"
            >
              Download PDF
            </LinkButton>
            {canCredit && (
              <ConfirmDialog
                trigger="Credit note"
                title="Issue a credit note"
                description="Issued invoices never change; a credit note corrects or refunds them. Money already paid beyond what is owed becomes member credit."
                confirmLabel="Issue credit note"
                formAction={creditNoteAction}
                fields={{ invoiceId: invoice.id }}
              >
                <FormField
                  label="Amount incl. tax (₹)"
                  name="amount"
                  inputMode="decimal"
                  required
                />
                <FormField label="Reason" name="reason" required />
              </ConfirmDialog>
            )}
            {canVoid && (
              <ConfirmDialog
                trigger="Void"
                title={`Void ${invoice.number}?`}
                description="Only for invoices nobody has paid. The number stays used."
                confirmLabel="Void invoice"
                formAction={voidInvoiceAction}
                fields={{ invoiceId: invoice.id }}
              >
                <FormField label="Reason" name="reason" required />
              </ConfirmDialog>
            )}
          </>
        }
      />
      <Flash params={await searchParams} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total" value={inr(invoice.totalMinor)} />
        <StatCard label="Paid" value={inr(balance.allocatedMinor)} />
        <StatCard label="Credited" value={inr(balance.creditedMinor)} />
        <StatCard
          label="Due"
          value={inr(balance.outstandingMinor)}
          tone={balance.outstandingMinor > 0 ? "warning" : "success"}
        />
      </div>
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>From</CardTitle>
          <p className="mt-2 text-sm">{supplier.legalName}</p>
          <p className="text-sm text-muted">
            {[supplier.branch, supplier.address].filter(Boolean).join(", ")}
          </p>
          {isTax && <p className="text-sm">GSTIN {supplier.gstin}</p>}
        </Card>
        <Card>
          <CardTitle>To</CardTitle>
          <p className="mt-2 text-sm">
            {memberName(invoice.member)} · {invoice.member.memberCode}
          </p>
          {isTax && invoice.placeOfSupply && (
            <p className="text-sm text-muted">
              Place of supply: state {invoice.placeOfSupply}
            </p>
          )}
        </Card>
      </div>
      <DataTable
        caption="Lines"
        rows={invoice.lines}
        rowKey={(l) => l.id}
        columns={[
          { key: "desc", header: "Description", cell: (l) => l.description },
          {
            key: "sac",
            header: "SAC",
            hideOnMobile: true,
            cell: (l) => l.sacCode ?? "—",
          },
          {
            key: "taxable",
            header: "Taxable",
            cell: (l) => inr(l.taxableMinor),
          },
          {
            key: "tax",
            header: "Tax",
            hideOnMobile: true,
            cell: (l) =>
              !isTax
                ? "—"
                : Number(l.igstMinor) > 0
                  ? `IGST ${inr(l.igstMinor)} (${l.igstRateBps / 100}%)`
                  : `CGST ${inr(l.cgstMinor)} + SGST ${inr(l.sgstMinor)} (${l.cgstRateBps / 100}% + ${l.sgstRateBps / 100}%)`,
          },
          { key: "total", header: "Amount", cell: (l) => inr(l.totalMinor) },
        ]}
      />
      {(invoice.allocations.length > 0 || invoice.creditNotes.length > 0) && (
        <section aria-labelledby="hist-h" className="mt-8">
          <h2 id="hist-h" className="mb-3 text-lg font-semibold">
            Payments and credits
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {invoice.allocations.map((a) => (
              <li
                key={a.id}
                className={a.reversedAt ? "text-muted line-through" : ""}
              >
                {when(a.createdAt, ctx.timezone)} · {inr(a.amountMinor)}{" "}
                {a.source === "CREDIT"
                  ? "from member credit"
                  : `from receipt ${a.payment?.receiptNumber}`}
                {a.reversedAt && " (reversed)"}
              </li>
            ))}
            {invoice.creditNotes.map((c) => (
              <li key={c.id}>
                {day(c.issueDate)} · credit note {c.number}: {inr(c.totalMinor)}{" "}
                ({c.reason})
              </li>
            ))}
          </ul>
        </section>
      )}
      {invoice.voidedAt && (
        <p className="mt-6 text-sm text-muted">
          Voided {when(invoice.voidedAt, ctx.timezone)}: {invoice.voidReason}
        </p>
      )}
      <OnlinePaymentPanel
        ctx={ctx}
        invoiceId={invoice.id}
        branchId={invoice.branchId}
        outstandingMinor={balance.outstandingMinor}
        open={!invoice.voidedAt && balance.outstandingMinor > 0}
      />
    </>
  );
}
