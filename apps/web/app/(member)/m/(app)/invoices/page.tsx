import { listMyInvoices } from "@gym/core/members";
import { onlinePaymentsEnabled } from "@gym/core/payments";
import { EmptyState, FormField, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { InvoiceBadge } from "@/components/invoice-badge";
import { day, inr, when } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import { payBalanceAction } from "../pay/actions";

export const metadata: Metadata = { title: "Payments" };

const METHOD: Record<string, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD_TERMINAL: "Card",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  ONLINE: "Online",
  OTHER: "Other",
};

export default async function MyInvoicesPage({
  searchParams,
}: PageProps<"/m/invoices">) {
  const { mctx } = await requireMember("/m/invoices");
  const sp = await searchParams;
  const { invoices, payments } = await listMyInvoices(services().db, mctx);
  const online = await onlinePaymentsEnabled(services().deps, mctx);
  const due = invoices.reduce((s, i) => s + i.balance.outstandingMinor, 0);

  return (
    <>
      <h1 className="text-2xl font-semibold">Payments</h1>
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-muted">Amount due</p>
        <p
          className={`text-3xl font-semibold ${due > 0 ? "text-warning" : ""}`}
        >
          {inr(due)}
        </p>
        {due > 0 && !online.enabled && (
          <p className="mt-1 text-sm text-muted">Pay at the front desk.</p>
        )}
        {due > 0 && online.enabled && (
          <form action={payBalanceAction} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="back" value="/m/invoices" />
            {online.partialAllowed && due > online.minPartialMinor && (
              <FormField
                label="Amount to pay (₹)"
                name="amount"
                inputMode="decimal"
                defaultValue={(due / 100).toFixed(2)}
                hint={`You can pay part of it, at least ${inr(online.minPartialMinor)}.`}
              />
            )}
            <SubmitButton size="lg" className="w-full">
              Pay online
            </SubmitButton>
            <p className="text-xs text-muted">
              UPI, cards and net banking, through Razorpay.
            </p>
          </form>
        )}
      </div>
      <Flash params={sp} />

      <section aria-labelledby="inv" className="flex flex-col gap-2">
        <h2 id="inv" className="text-sm font-semibold">
          Invoices
        </h2>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices yet" />
        ) : (
          <ul className="flex flex-col gap-2">
            {invoices.map((i) => (
              <li key={i.id}>
                <a
                  href={`/m/invoices/${i.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface p-3 hover:border-primary"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{i.number}</span>
                    <span className="text-xs text-muted">
                      {day(i.issueDate)}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <span className="font-medium">{inr(i.totalMinor)}</span>
                    <InvoiceBadge status={i.status} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {payments.length > 0 && (
        <section aria-labelledby="pay" className="flex flex-col gap-2">
          <h2 id="pay" className="text-sm font-semibold">
            Payments received
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {payments.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <span className="flex flex-col">
                  <span>{METHOD[p.method] ?? p.method}</span>
                  <span className="text-xs text-muted">
                    {p.receiptNumber} ·{when(p.receivedAt, mctx.timezone)}
                  </span>
                </span>
                <span className="font-medium">{inr(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
