import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getPaymentIntegration, getPaymentPolicies } from "@gym/core/payments";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  ConfirmDialog,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../settings-tabs";
import {
  connectAction,
  disconnectAction,
  policiesAction,
  verifyAction,
} from "./actions";

export const metadata: Metadata = { title: "Online payments" };

export default async function PaymentSettingsPage({
  searchParams,
}: PageProps<"/settings/payments">) {
  const { ctx } = await requireReady("/settings/payments");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const { deps, appUrl, fakePayments } = services();
  const [integration, policies] = [
    await getPaymentIntegration(deps, ctx),
    await getPaymentPolicies(deps, ctx),
  ];
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "settings.payments");
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/payments" />
      <Flash params={await searchParams} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <CardTitle>Razorpay account</CardTitle>
          {integration ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="success">Connected</Badge>
                <Badge tone={integration.mode === "LIVE" ? "warning" : "info"}>
                  {integration.mode === "LIVE" ? "Live" : "Test mode"}
                </Badge>
                {integration.provider === "FAKE" && (
                  <Badge>Test provider (development)</Badge>
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Key id</dt>
                <dd className="font-mono">{integration.keyId}</dd>
                <dt className="text-muted">Key secret</dt>
                <dd className="font-mono">••••{integration.secretLast4}</dd>
                <dt className="text-muted">Last checked</dt>
                <dd>{when(integration.lastVerifiedAt, ctx.timezone)}</dd>
              </dl>
              <div className="rounded-md border border-border bg-background p-3 text-sm">
                <p className="font-medium">
                  Webhook (add it in Razorpay → Settings → Webhooks)
                </p>
                <p
                  className="mt-1 break-all font-mono text-xs"
                  data-testid="webhook-url"
                >
                  {appUrl}
                  {integration.webhookPath}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Secret: the webhook secret you entered here. Events:{" "}
                  {integration.events.join(", ")}.
                </p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <form action={verifyAction}>
                    <Button type="submit" variant="outline" size="sm">
                      Check keys
                    </Button>
                  </form>
                  <ConfirmDialog
                    trigger="Disconnect"
                    title="Disconnect Razorpay?"
                    description="Members can't pay online until you connect again. Open links stop being accepted."
                    confirmLabel="Disconnect"
                    formAction={disconnectAction}
                  >
                    <label className="flex flex-col gap-1.5 text-sm font-medium">
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        className="h-10 rounded-md border border-border bg-surface px-3"
                      />
                    </label>
                  </ConfirmDialog>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">
              Not connected. Members pay at the front desk until you connect
              your own Razorpay account. Money goes straight to your account.
            </p>
          )}
          {canEdit && (
            <details
              open={!integration}
              className="rounded-md border border-border p-3"
            >
              <summary className="cursor-pointer text-sm font-medium">
                {integration ? "Replace the keys" : "Connect Razorpay"}
              </summary>
              <ActionForm
                action={connectAction}
                className="mt-3 flex flex-col gap-3"
              >
                {fakePayments && (
                  <SelectField
                    label="Provider"
                    name="provider"
                    defaultValue="RAZORPAY"
                    options={[
                      { value: "RAZORPAY", label: "Razorpay" },
                      {
                        value: "FAKE",
                        label: "Test provider (development only)",
                      },
                    ]}
                  />
                )}
                <SelectField
                  label="Mode"
                  name="mode"
                  defaultValue="TEST"
                  options={[
                    { value: "TEST", label: "Test (rzp_test_…)" },
                    { value: "LIVE", label: "Live (rzp_live_…)" },
                  ]}
                />
                <FormField
                  label="Key id"
                  name="keyId"
                  autoComplete="off"
                  required
                />
                <FormField
                  label="Key secret"
                  name="keySecret"
                  type="password"
                  autoComplete="off"
                  required
                />
                <FormField
                  label="Webhook secret"
                  name="webhookSecret"
                  type="password"
                  autoComplete="off"
                  required
                  hint="Choose any long random text; enter the same in Razorpay's webhook settings."
                />
                <div>
                  <SubmitButton>Check and connect</SubmitButton>
                </div>
              </ActionForm>
            </details>
          )}
        </Card>
        <Card className="flex flex-col gap-4">
          <CardTitle>Rules</CardTitle>
          <ActionForm action={policiesAction} className="flex flex-col gap-3">
            <fieldset disabled={!canEdit} className="flex flex-col gap-3">
              <FormField
                label="Payment links expire after (days)"
                name="paymentLinkExpiryDays"
                type="number"
                min={1}
                max={180}
                defaultValue={policies.paymentLinkExpiryDays}
              />
              <CheckboxField
                name="onlinePartialAllowed"
                label="Members may pay part of their balance online"
                defaultChecked={policies.onlinePartialAllowed}
              />
              <FormField
                label="Smallest part payment (₹)"
                name="onlineMinPartial"
                inputMode="decimal"
                defaultValue={String(policies.onlineMinPartialMinor / 100)}
              />
              <FormField
                label="Refunds above this need a second person's approval (₹)"
                name="refundApprovalThreshold"
                inputMode="decimal"
                defaultValue={
                  policies.refundApprovalThresholdMinor === null
                    ? ""
                    : String(policies.refundApprovalThresholdMinor / 100)
                }
                hint="Empty = no second approval."
              />
              <FormField
                label="Remind members on these days overdue"
                name="duesReminderDays"
                defaultValue={policies.duesReminderDays.join(", ")}
                hint="e.g. 1, 7, 14, 30. Empty = no reminders."
              />
              {canEdit && (
                <div>
                  <SubmitButton variant="outline">Save rules</SubmitButton>
                </div>
              )}
            </fieldset>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
