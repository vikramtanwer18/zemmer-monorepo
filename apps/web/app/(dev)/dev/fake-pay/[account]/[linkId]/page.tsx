import {
  FakePaymentProvider,
  redisFakeStore,
  signWebhook,
} from "@gym/integrations/payments";
import { Alert, AuthCard, Button } from "@gym/ui";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { inr } from "@/lib/format";
import { getRedis } from "@/lib/queue";
import { services } from "@/lib/services";

/**
 * TEST CHECKOUT (development only). Stands in for Razorpay's hosted page: "pays" the link in the
 * fake provider and delivers the signed webhook to this server, exactly as Razorpay would. Never
 * available in production (PAYMENTS_FAKE_ENABLED is refused there).
 */
function fake(account: string) {
  return new FakePaymentProvider(redisFakeStore(getRedis()), account, "n/a");
}

async function pay(form: FormData) {
  "use server";
  if (!services().fakePayments) notFound();
  const account = String(form.get("account"));
  const linkId = String(form.get("linkId"));
  const rupees = String(form.get("amount") ?? "").trim();
  const skipWebhook = form.get("skipWebhook") === "on";
  const provider = fake(account);
  const link = await provider.rawLink(linkId);
  const integrationId = String(
    (link.notes as Record<string, string>)?.integrationId ?? "",
  );
  const { webhook } = await provider.pay(
    linkId,
    rupees ? Math.round(Number(rupees) * 100) : undefined,
  );
  if (!skipWebhook && integrationId) {
    const rows = await services().db.$queryRaw<
      { webhook_secret_enc: string }[]
    >`
      SELECT webhook_secret_enc FROM app.webhook_integration(${integrationId}::uuid)`;
    const secret = services()
      .deps.secrets!.decrypt(rows[0]!.webhook_secret_enc)
      .toString("utf8");
    // Deliver to the server that served this page (works on any port).
    const host = (await headers()).get("host");
    await fetch(`http://${host}/api/webhooks/razorpay/${integrationId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signWebhook(webhook.rawBody, secret),
        "x-razorpay-event-id": webhook.eventId,
      },
      body: webhook.rawBody,
    });
  }
  const callback = link.callback_url
    ? new URL(String(link.callback_url))
    : null;
  redirect(
    callback
      ? `${callback.pathname}${callback.search}`
      : `/dev/fake-pay/${account}/${linkId}?paid=1`,
  );
}

export default async function FakeCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; linkId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!services().fakePayments) notFound();
  const { account, linkId } = await params;
  const sp = await searchParams;
  let link: Record<string, unknown>;
  try {
    link = await fake(decodeURIComponent(account)).rawLink(linkId);
  } catch {
    notFound();
  }
  const due = Number(link.amount) - Number(link.amount_paid);
  const open = link.status === "created" || link.status === "partially_paid";
  return (
    <AuthCard
      brand={services().brand}
      title="Test checkout"
      description="Development only. No real money moves: this page stands in for Razorpay."
    >
      {sp.paid && <Alert tone="success">Paid.</Alert>}
      <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-muted">For</dt>
        <dd>{String(link.description ?? "")}</dd>
        <dt className="text-muted">Amount</dt>
        <dd>{inr(Number(link.amount))}</dd>
        <dt className="text-muted">Still due</dt>
        <dd data-testid="fake-due">{inr(due)}</dd>
        <dt className="text-muted">Status</dt>
        <dd>{String(link.status)}</dd>
      </dl>
      {open ? (
        <form action={pay} className="flex flex-col gap-3">
          <input
            type="hidden"
            name="account"
            value={decodeURIComponent(account)}
          />
          <input type="hidden" name="linkId" value={linkId} />
          {Boolean(link.accept_partial) && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Amount to pay now (₹, empty = all)
              <input
                name="amount"
                inputMode="decimal"
                className="h-10 rounded-md border border-border bg-surface px-3"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="skipWebhook" className="size-4" />
            Don&apos;t send the webhook (to test reconciliation)
          </label>
          <Button type="submit">Pay {inr(due)}</Button>
        </form>
      ) : (
        <p className="text-sm text-muted">
          This link is {String(link.status)}.
        </p>
      )}
    </AuthCard>
  );
}
