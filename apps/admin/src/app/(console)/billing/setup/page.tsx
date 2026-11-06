import { GST_STATES } from "@gym/core/gst";
import {
  getBillingSettings,
  getPlatformPaymentAccount,
  listPrices,
} from "@gym/core/saas-billing";
import {
  ActionForm,
  Alert,
  Breadcrumbs,
  Button,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { getEnv } from "@/env";
import { at, inr } from "@/lib/format";
import { Notices } from "@/lib/notices";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import {
  setPaymentAccountAction,
  updateBillingSettingsAction,
  updatePriceAction,
} from "../actions";

export const metadata: Metadata = { title: "Payment account and prices" };

const CYCLE = {
  MONTHLY: "Monthly",
  HALF_YEARLY: "Every 6 months",
  YEARLY: "Yearly",
} as const;

export default async function BillingSetupPage({
  searchParams,
}: PageProps<"/billing/setup">) {
  const { ctx } = await requireAdmin("/billing/setup");
  if (!ctx.permissions.has("platform.billing.manage"))
    return (
      <EmptyState
        title="No access"
        description="Only a Super Admin can change billing setup."
      />
    );
  const sp = await searchParams;
  const { billing } = services();
  const [account, prices, settings] = [
    await getPlatformPaymentAccount(billing, ctx),
    await listPrices(billing.db),
    await getBillingSettings(billing, ctx),
  ];
  const webhookUrl = `${getEnv().ADMIN_URL.replace(/\/$/, "")}/api/webhooks/razorpay-platform`;
  return (
    <>
      <Breadcrumbs
        items={[{ label: "Billing", href: "/billing" }, { label: "Setup" }]}
      />
      <PageHeader title="Payment account and prices" />
      <Notices sp={sp} />

      <section aria-labelledby="acct" className="mb-8 max-w-2xl">
        <h2 id="acct" className="mb-3 text-base font-semibold">
          Platform Razorpay account
        </h2>
        {account ? (
          <Alert
            tone={account.mode === "LIVE" ? "success" : "info"}
            className="mb-4"
          >
            {account.provider === "FAKE"
              ? "Test provider (development)"
              : `Razorpay ${account.mode.toLowerCase()} mode`}{" "}
            · key {account.keyId} · secret ending {account.secretLast4} ·
            checked {at(account.lastVerifiedAt)}
          </Alert>
        ) : (
          <Alert tone="warning" className="mb-4">
            Not set up. Gym owners can't subscribe until it is.
          </Alert>
        )}
        <p className="mb-3 text-sm text-muted">
          In the Razorpay dashboard, add a webhook to{" "}
          <code className="break-all">{webhookUrl}</code> with the
          subscription.* events and a secret, then paste the keys here. Secrets
          are encrypted and never shown again.
        </p>
        <ActionForm
          action={setPaymentAccountAction}
          resetOnSuccess
          className="flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Provider"
              name="provider"
              defaultValue="RAZORPAY"
              options={[
                { value: "RAZORPAY", label: "Razorpay" },
                ...(services().fakePayments
                  ? [{ value: "FAKE", label: "Test provider (development)" }]
                  : []),
              ]}
            />
            <SelectField
              label="Mode"
              name="mode"
              defaultValue="TEST"
              options={[
                { value: "TEST", label: "Test" },
                { value: "LIVE", label: "Live" },
              ]}
            />
            <FormField
              label="Key id"
              name="keyId"
              required
              autoComplete="off"
            />
            <FormField
              label="Key secret"
              name="keySecret"
              type="password"
              required
              autoComplete="off"
            />
            <FormField
              label="Webhook secret"
              name="webhookSecret"
              type="password"
              required
              autoComplete="off"
            />
          </div>
          <div>
            <SubmitButton>
              {account ? "Replace account" : "Save account"}
            </SubmitButton>
          </div>
        </ActionForm>
      </section>

      <section aria-labelledby="supplier" className="mb-8 max-w-2xl">
        <h2 id="supplier" className="mb-1 text-base font-semibold">
          On gym subscription invoices
        </h2>
        <p className="mb-3 text-sm text-muted">
          You are the supplier. Without a GSTIN no GST is shown or charged. The
          SAC code and rate are to be confirmed by your CA.
        </p>
        <ActionForm
          action={updateBillingSettingsAction}
          className="flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Legal name"
              name="legalName"
              required
              defaultValue={settings.supplier.legalName}
            />
            <FormField
              label="GSTIN (optional)"
              name="gstin"
              defaultValue={settings.supplier.gstin ?? ""}
              autoCapitalize="characters"
            />
            <SelectField
              label="State"
              name="stateCode"
              defaultValue={settings.supplier.stateCode}
              options={Object.entries(GST_STATES).map(([code, name]) => ({
                value: code,
                label: `${code} ${name}`,
              }))}
            />
            <FormField
              label="Address"
              name="address"
              defaultValue={settings.supplier.address}
            />
            <FormField
              label="SAC code"
              name="sacCode"
              required
              defaultValue={settings.sacCode}
            />
            <FormField
              label="GST rate (%)"
              name="taxRatePercent"
              inputMode="decimal"
              required
              defaultValue={String(settings.taxRateBps / 100)}
            />
            <FormField
              label="Grace period after failed payments (days)"
              name="graceDays"
              type="number"
              min={0}
              max={60}
              required
              defaultValue={settings.graceDays}
              hint="Fully usable during grace; read-only after."
            />
          </div>
          <div>
            <SubmitButton variant="outline">Save billing settings</SubmitButton>
          </div>
        </ActionForm>
      </section>

      <h2 className="mb-3 text-base font-semibold">Prices (include GST)</h2>
      <DataTable
        caption="Plan prices"
        rows={prices}
        rowKey={(p) => p.id}
        empty={<EmptyState title="No prices" />}
        columns={[
          {
            key: "plan",
            header: "Plan",
            cell: (p) => `${p.plan.name} (v${p.plan.version})`,
          },
          { key: "cycle", header: "Cycle", cell: (p) => CYCLE[p.cycle] },
          { key: "amount", header: "Price", cell: (p) => inr(p.amountMinor) },
          {
            key: "monthly",
            header: "Per month",
            hideOnMobile: true,
            cell: (p) => inr(p.monthlyMinor),
          },
          {
            key: "edit",
            header: "",
            cell: (p) => (
              <form action={updatePriceAction} className="flex items-end gap-2">
                <input type="hidden" name="priceId" value={p.id} />
                <label className="sr-only" htmlFor={`amt-${p.id}`}>
                  New price for {p.plan.name} {CYCLE[p.cycle]} (₹)
                </label>
                <input
                  id={`amt-${p.id}`}
                  name="amount"
                  inputMode="decimal"
                  defaultValue={(p.amountMinor / 100).toFixed(0)}
                  className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-sm"
                />
                <Button type="submit" size="sm" variant="outline">
                  Save
                </Button>
              </form>
            ),
          },
        ]}
      />
      <p className="mt-2 text-xs text-muted">
        Changing a price creates a new Razorpay plan at the next checkout.
        Existing subscribers keep what they pay.
      </p>
    </>
  );
}
