import { hasPermission } from "@gym/core/authz";
import { creditBalance, openInvoices } from "@gym/core/billing";
import { isAppError } from "@gym/core/errors";
import { getMemberProfile, memberName } from "@gym/core/members";
import { inTenant } from "@gym/core/tenancy";
import { todayIn } from "@gym/core/time/dates";
import {
  ActionForm,
  Breadcrumbs,
  FormField,
  PageHeader,
  RadioGroup,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { inr } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { recordPaymentAction } from "../../actions";

export const metadata: Metadata = { title: "Record payment" };

export default async function PayPage({
  params,
}: PageProps<"/members/[id]/pay">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/members/${id}/pay`);
  const { deps } = services();
  const profile = await getMemberProfile(deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    return null;
  });
  if (
    !profile ||
    !hasPermission(ctx, "billing.collect", {
      branchId: profile.member.homeBranchId,
    })
  )
    return <NoAccess />;
  const { open, credit } = await inTenant(deps, ctx, async (tx) => ({
    open: await openInvoices(tx, id),
    credit: await creditBalance(tx, id),
  }));
  const due = open.reduce((s, i) => s + i.outstandingMinor, 0);
  const name = memberName(profile.member);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: name, href: `/members/${id}?tab=billing` },
          { label: "Record payment" },
        ]}
      />
      <PageHeader
        title={`Record a payment from ${name}`}
        description={`Outstanding ${inr(due)}${credit > 0 ? ` · credit ${inr(credit)}` : ""}`}
      />
      <ActionForm
        action={recordPaymentAction}
        className="flex max-w-2xl flex-col gap-4"
      >
        <input type="hidden" name="memberId" value={id} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Amount received (₹)"
            name="amount"
            inputMode="decimal"
            defaultValue={due > 0 ? (due / 100).toFixed(2) : ""}
            required
          />
          <FormField
            label="Date received"
            name="receivedOn"
            type="date"
            max={todayIn(ctx.timezone)}
            defaultValue={todayIn(ctx.timezone)}
          />
          <SelectField
            label="Method"
            name="method"
            options={[
              { value: "CASH", label: "Cash" },
              { value: "UPI", label: "UPI (collected outside the app)" },
              { value: "BANK_TRANSFER", label: "Bank transfer" },
              { value: "CARD_TERMINAL", label: "Card machine" },
              { value: "CHEQUE", label: "Cheque" },
              { value: "OTHER", label: "Other" },
            ]}
          />
          <FormField
            label="Reference"
            name="reference"
            hint="Required for UPI, bank transfer, card and cheque."
          />
        </div>
        <TextareaField label="Notes (optional)" name="notes" />
        {open.length > 0 ? (
          <fieldset className="flex flex-col gap-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-semibold">Apply to</legend>
            <RadioGroup
              legend="Allocation"
              name="allocationMode"
              defaultValue="auto"
              options={[
                {
                  value: "auto",
                  label: "Oldest invoice first",
                  hint: "Anything left over becomes credit.",
                },
                {
                  value: "manual",
                  label: "Split it myself",
                  hint: "Fill in amounts below; the rest becomes credit.",
                },
              ]}
            />
            <table className="w-full text-sm">
              <caption className="sr-only">Open invoices</caption>
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th scope="col" className="py-1">
                    Invoice
                  </th>
                  <th scope="col" className="py-1">
                    Due
                  </th>
                  <th scope="col" className="py-1">
                    Allocate (₹)
                  </th>
                </tr>
              </thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1">
                      {i.number} · {i.issueDate}
                    </td>
                    <td className="py-1">{inr(i.outstandingMinor)}</td>
                    <td className="py-1">
                      <label className="sr-only" htmlFor={`alloc-${i.id}`}>
                        Allocate to {i.number}
                      </label>
                      <input
                        id={`alloc-${i.id}`}
                        name={`alloc:${i.id}`}
                        inputMode="decimal"
                        className="h-9 w-28 rounded-md border border-border bg-surface px-2"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </fieldset>
        ) : (
          <p className="text-sm text-muted">
            No open invoices: the whole amount becomes credit for future
            invoices.
          </p>
        )}
        <div>
          <SubmitButton>Record payment</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
