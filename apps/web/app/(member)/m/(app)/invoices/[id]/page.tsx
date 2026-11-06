import { isAppError } from "@gym/core/errors";
import { getMyInvoice } from "@gym/core/members";
import { LinkButton } from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InvoiceBadge } from "@/components/invoice-badge";
import { day, inr } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Invoice" };

export default async function MyInvoicePage({
  params,
}: PageProps<"/m/invoices/[id]">) {
  const { id } = await params;
  const { mctx } = await requireMember(`/m/invoices/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await getMyInvoice(services().db, mctx, id).catch(
    (err: unknown) => {
      if (isAppError(err) && err.code === "NOT_FOUND") return null;
      throw err;
    },
  );
  if (!result) notFound();
  const { invoice, balance } = result;
  const tax =
    Number(invoice.cgstMinor) +
    Number(invoice.sgstMinor) +
    Number(invoice.igstMinor);

  return (
    <>
      <a href="/m/invoices" className="text-sm text-primary underline">
        Back to payments
      </a>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{invoice.number}</h1>
          <p className="text-sm text-muted">Issued {day(invoice.issueDate)}</p>
        </div>
        <InvoiceBadge status={invoice.status} />
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
        {invoice.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-3 p-3 text-sm">
            <span>{l.description}</span>
            <span className="font-medium">{inr(l.totalMinor)}</span>
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-2 gap-y-1 rounded-md border border-border bg-surface p-3 text-sm">
        <dt className="text-muted">Taxable value</dt>
        <dd className="text-right">{inr(invoice.taxableMinor)}</dd>
        <dt className="text-muted">GST</dt>
        <dd className="text-right">{inr(tax)}</dd>
        <dt className="font-medium">Total</dt>
        <dd className="text-right font-medium">{inr(invoice.totalMinor)}</dd>
        <dt className="text-muted">Paid</dt>
        <dd className="text-right">{inr(balance.allocatedMinor)}</dd>
        {balance.creditedMinor > 0 && (
          <>
            <dt className="text-muted">Credited</dt>
            <dd className="text-right">{inr(balance.creditedMinor)}</dd>
          </>
        )}
        <dt className="font-medium">Due</dt>
        <dd
          className={`text-right font-semibold ${balance.outstandingMinor > 0 ? "text-warning" : ""}`}
        >
          {inr(balance.outstandingMinor)}
        </dd>
      </dl>

      {invoice.creditNotes.length > 0 && (
        <p className="text-sm text-muted">
          Credit notes:{" "}
          {invoice.creditNotes
            .map((c) => `${c.number} (${inr(c.totalMinor)})`)
            .join(", ")}
        </p>
      )}

      <LinkButton
        href={`/api/invoices/${invoice.id}/pdf`}
        variant="outline"
        download
      >
        Download PDF
      </LinkButton>
    </>
  );
}
