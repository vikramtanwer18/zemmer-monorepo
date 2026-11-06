import {
  FakeSubscriptionProvider,
  redisFakeStore,
  signWebhook,
} from "@gym/integrations/payments";
import { AuthCard, Button } from "@gym/ui";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { services } from "@/lib/services";

export const metadata: Metadata = {
  title: "Test subscription checkout",
  robots: { index: false },
};

/**
 * TEST CHECKOUT (development only) for gym subscriptions. Stands in for Razorpay's hosted page:
 * the gym owner "pays", the fake provider produces Razorpay-shaped events, and they're delivered,
 * signed, to this app's platform webhook. 404 unless PAYMENTS_FAKE_ENABLED (refused in production).
 */
function fake() {
  return new FakeSubscriptionProvider(redisFakeStore(services().redis));
}

async function deliver(what: "charge" | "fail", subId: string) {
  const { billing } = services();
  const account = await billing.db.platformPaymentAccount.findFirst({
    where: { active: true },
  });
  if (!account) throw new Error("No platform payment account set up.");
  const secret = billing.secrets
    .decrypt(account.webhookSecretEnc)
    .toString("utf8");
  const host = (await headers()).get("host");
  for (const hook of await fake().simulate(subId, what)) {
    await fetch(`http://${host}/api/webhooks/razorpay-platform`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signWebhook(hook.rawBody, secret),
        "x-razorpay-event-id": hook.eventId,
      },
      body: hook.rawBody,
    });
  }
}

async function act(form: FormData) {
  "use server";
  if (!services().fakePayments) notFound();
  const subId = String(form.get("subId"));
  const what = form.get("what") === "fail" ? "fail" : "charge";
  await deliver(what, subId);
  redirect(
    `${services().appUrl}/settings/plan?${new URLSearchParams({ notice: what === "charge" ? "Payment made. Your plan updates in a few seconds." : "Test: the payment failed." })}`,
  );
}

export default async function FakeSubscribePage({
  params,
}: PageProps<"/dev/fake-subscribe/[subId]">) {
  if (!services().fakePayments) notFound();
  const { subId } = await params;
  let sub;
  try {
    sub = await fake().fetchSubscription(subId);
  } catch {
    notFound();
  }
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <AuthCard
        brand={services().brand}
        title="Test subscription checkout"
        description="Development only. No real money moves: this page stands in for Razorpay."
      >
        <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Subscription</dt>
          <dd>{sub.id}</dd>
          <dt className="text-muted">Status</dt>
          <dd>{sub.status}</dd>
        </dl>
        <form action={act} className="flex flex-col gap-2">
          <input type="hidden" name="subId" value={sub.id} />
          <Button type="submit" name="what" value="charge">
            Pay and subscribe
          </Button>
          <Button type="submit" name="what" value="fail" variant="outline">
            Simulate a failed payment
          </Button>
        </form>
      </AuthCard>
    </main>
  );
}
