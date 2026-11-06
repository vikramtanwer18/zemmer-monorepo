import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { PAYMENT_METHODS } from "@gym/core/billing";
import { getPaymentForRefund } from "@gym/core/payments";
import {
  ActionForm,
  Alert,
  Badge,
  Breadcrumbs,
  Card,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { inr, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { requestRefundAction } from "../../refunds/actions";

export const metadata: Metadata = { title: "Refund a payment" };

export default async function RefundPaymentPage({
  params,
}: PageProps<"/payments/[id]/refund">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/payments/${id}/refund`);
  if (!hasPermission(ctx, "billing.refund") || !isTenantWritable(ctx))
    return <NoAccess />;
  const p = await getPaymentForRefund(services().deps, ctx, id);
  const rupees = (minor: number) => (minor / 100).toFixed(2);
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Payments", href: "/payments" },
          { label: `Receipt ${p.receiptNumber}` },
        ]}
      />
      <PageHeader
        title={`Refund receipt ${p.receiptNumber}`}
        description={`${p.member.name} · paid ${inr(p.amountMinor)} by ${p.online ? "online payment" : p.method.replace("_", " ").toLowerCase()}`}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {p.status !== "SUCCEEDED" ? (
            <Alert tone="warning">
              This payment was voided, so it can't be refunded.
            </Alert>
          ) : p.refundableMinor <= 0 ? (
            <Alert tone="info">This payment has been fully refunded.</Alert>
          ) : (
            <ActionForm
              action={requestRefundAction}
              className="flex max-w-xl flex-col gap-4"
            >
              <input type="hidden" name="paymentId" value={p.id} />
              <FormField
                label="Amount (₹)"
                name="amount"
                inputMode="decimal"
                required
                defaultValue={rupees(p.refundableMinor)}
                hint={`Up to ${inr(p.refundableMinor)}.`}
              />
              <TextareaField
                label="Reason"
                name="reason"
                rows={2}
                required
                minLength={5}
              />
              {p.online ? (
                <Alert tone="info">
                  The money goes back to the card, UPI or bank account the
                  member paid with, through Razorpay. It usually reaches them in
                  5–7 working days.
                </Alert>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label="Given back by"
                    name="method"
                    required
                    placeholder="Pick one"
                    options={PAYMENT_METHODS.map((m) => ({
                      value: m,
                      label: m.replace("_", " ").toLowerCase(),
                    }))}
                  />
                  <FormField
                    label="Reference (optional)"
                    name="reference"
                    hint="UPI ref, cheque no."
                  />
                </div>
              )}
              {p.hasMembership && hasPermission(ctx, "memberships.manage") && (
                <CheckboxField
                  label="Also cancel the membership this paid for"
                  name="cancelMembership"
                  hint="Use this when the member is leaving. Leave it off for a partial goodwill refund."
                />
              )}
              <p className="text-sm text-muted">
                A credit note is issued against the invoice
                {p.invoices.length === 1 ? "" : "s"}{" "}
                {p.invoices.join(", ") || "(credit only)"}. The invoice itself
                is not changed. If your gym needs a second person to approve
                large refunds, this will wait for them.
              </p>
              <div>
                <SubmitButton>Refund</SubmitButton>
              </div>
            </ActionForm>
          )}
        </div>
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Earlier refunds</h2>
          {p.refunds.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {p.refunds.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span>
                    {inr(r.amountMinor)}
                    <span className="block text-xs text-muted">
                      {when(r.createdAt, ctx.timezone)}
                    </span>
                  </span>
                  <Badge
                    tone={
                      r.status === "PROCESSED"
                        ? "success"
                        : r.status === "FAILED"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {r.status.replace("_", " ").toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
