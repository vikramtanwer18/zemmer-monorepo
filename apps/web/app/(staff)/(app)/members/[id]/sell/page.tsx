import { hasPermission } from "@gym/core/authz";
import { leadsAwaitingSale } from "@gym/core/crm";
import { isAppError } from "@gym/core/errors";
import { getMemberProfile, memberName } from "@gym/core/members";
import { previewSale } from "@gym/core/memberships";
import { sellablePlans } from "@gym/core/plans";
import { inTenant } from "@gym/core/tenancy";
import { todayIn } from "@gym/core/time/dates";
import {
  ActionForm,
  Alert,
  Breadcrumbs,
  Card,
  CardTitle,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { inr, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { sellMembershipAction } from "../../actions";

export const metadata: Metadata = { title: "Sell membership" };

const ACTIVATION: Record<string, string> = {
  FULL_PAYMENT: "The membership starts once the invoice is fully paid.",
  ANY_PAYMENT: "The membership starts with the first payment.",
  IMMEDIATE: "The membership starts straight away; dues stay open.",
};

/**
 * Step 1 (GET with plan/start/coupon): server-rendered preview with the exact invoice.
 * Step 2: confirm, optionally recording a payment now.
 */
export default async function SellPage({
  params,
  searchParams,
}: PageProps<"/members/[id]/sell">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/members/${id}/sell`);
  const sp = await searchParams;
  const { deps } = services();
  const profile = await getMemberProfile(deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    return null;
  });
  if (
    !profile ||
    !hasPermission(ctx, "memberships.sell", {
      branchId: profile.member.homeBranchId,
    })
  )
    return <NoAccess />;
  const branchId = ctx.activeBranchId ?? profile.member.homeBranchId;
  const plans = await inTenant(deps, ctx, (tx) => sellablePlans(tx, branchId));
  const today = todayIn(ctx.timezone);
  const planId = str(sp.planId);
  const startDate = str(sp.startDate) ?? today;
  const couponCode = str(sp.couponCode);
  // M5: selling to a converted lead. The core checks the lead belongs to this member.
  const leads = await leadsAwaitingSale(deps, ctx, id);
  const lead = leads.find((l) => l.id === str(sp.leadId)) ?? null;

  let preview: Awaited<ReturnType<typeof previewSale>> | null = null;
  let error: string | null = null;
  if (planId) {
    try {
      preview = await previewSale(deps, ctx, {
        memberId: id,
        planId,
        startDate,
        couponCode,
        branchId,
      });
    } catch (err) {
      if (!isAppError(err)) throw err;
      error = err.fields
        ? (Object.values(err.fields).flat()[0] ?? err.message)
        : err.message;
    }
  }
  const canCollect = hasPermission(ctx, "billing.collect", { branchId });
  const name = memberName(profile.member);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: name, href: `/members/${id}` },
          { label: "Sell membership" },
        ]}
      />
      <PageHeader title={`Sell a membership to ${name}`} />
      {lead && (
        <Alert tone="info" className="mb-4">
          From the lead{" "}
          <a className="font-medium underline" href={`/leads/${lead.id}`}>
            {lead.name}
          </a>
          : it is marked won when this membership is paid.
        </Alert>
      )}
      {plans.length === 0 ? (
        <Alert tone="warning">
          No plans are sold at this branch yet.{" "}
          <a className="underline" href="/plans/new">
            Create a plan
          </a>
          .
        </Alert>
      ) : (
        <div className="grid max-w-4xl grid-cols-1 gap-6 lg:grid-cols-2">
          <form
            method="get"
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
          >
            <h2 className="font-semibold">1. Choose</h2>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Plan
              <select
                name="planId"
                defaultValue={planId ?? ""}
                required
                className="h-10 rounded-md border border-border bg-surface px-2 font-normal"
              >
                <option value="">Choose a plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {inr(p.priceMinor)} · {p.durationCount}{" "}
                    {p.durationUnit.toLowerCase()}
                    {p.durationCount === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Start date
              <input
                type="date"
                name="startDate"
                min={today}
                defaultValue={startDate}
                className="h-10 rounded-md border border-border bg-surface px-3 font-normal"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Coupon (optional)
              <input
                name="couponCode"
                defaultValue={couponCode}
                className="h-10 rounded-md border border-border bg-surface px-3 font-normal uppercase"
              />
            </label>
            <div>
              <button
                type="submit"
                className="h-10 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-background"
              >
                Preview invoice
              </button>
            </div>
            {lead && <input type="hidden" name="leadId" value={lead.id} />}
          </form>

          {error && <Alert tone="danger">{error}</Alert>}
          {preview && (
            <Card>
              <CardTitle>2. Check and confirm</CardTitle>
              <p className="mt-1 text-sm text-muted">
                {preview.plan.name}: {preview.startDate} to {preview.endDate}
              </p>
              <table className="mt-4 w-full text-sm">
                <caption className="sr-only">Invoice preview</caption>
                <tbody className="divide-y divide-border">
                  {preview.draft.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-2">
                        {l.description}
                        {l.result.discountMinor > 0 && (
                          <div className="text-xs text-muted">
                            Discount {inr(l.result.discountMinor)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {inr(l.result.totalMinor)}
                      </td>
                    </tr>
                  ))}
                  {preview.draft.documentType === "TAX_INVOICE" && (
                    <tr>
                      <td className="py-2 text-muted">
                        Taxable {inr(preview.draft.totals.taxableMinor)} ·{" "}
                        {preview.draft.supply === "INTER"
                          ? `IGST ${inr(preview.draft.totals.igstMinor)}`
                          : `CGST ${inr(preview.draft.totals.cgstMinor)} + SGST ${inr(preview.draft.totals.sgstMinor)}`}
                      </td>
                      <td />
                    </tr>
                  )}
                  <tr className="font-semibold">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right">
                      {inr(preview.draft.totals.totalMinor)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                {preview.draft.documentType === "TAX_INVOICE"
                  ? "Tax invoice"
                  : "Bill (not GST registered)"}
                . {ACTIVATION[preview.activation]}
              </p>
              {preview.warnings.map((w) => (
                <p key={w} className="mt-1 text-xs text-muted">
                  {w}
                </p>
              ))}
              <ActionForm
                action={sellMembershipAction}
                className="mt-4 flex flex-col gap-3"
              >
                <input type="hidden" name="memberId" value={id} />
                <input type="hidden" name="planId" value={preview.plan.id} />
                <input
                  type="hidden"
                  name="startDate"
                  value={preview.startDate}
                />
                {couponCode && (
                  <input type="hidden" name="couponCode" value={couponCode} />
                )}
                {lead && <input type="hidden" name="leadId" value={lead.id} />}
                {canCollect && (
                  <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
                    <CheckboxField name="payNow" label="Record a payment now" />
                    <FormField
                      label="Amount (₹)"
                      name="amount"
                      inputMode="decimal"
                      defaultValue={(
                        preview.draft.totals.totalMinor / 100
                      ).toFixed(2)}
                    />
                    <SelectField
                      label="Method"
                      name="method"
                      options={[
                        { value: "CASH", label: "Cash" },
                        { value: "UPI", label: "UPI" },
                        { value: "BANK_TRANSFER", label: "Bank transfer" },
                        { value: "CARD_TERMINAL", label: "Card machine" },
                        { value: "CHEQUE", label: "Cheque" },
                        { value: "OTHER", label: "Other" },
                      ]}
                    />
                    <FormField
                      label="Reference"
                      name="reference"
                      hint="UPI / bank / cheque reference."
                    />
                  </fieldset>
                )}
                <SubmitButton>Issue invoice and sell</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
