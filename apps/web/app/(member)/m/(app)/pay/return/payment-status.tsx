"use client";

import { Alert, LinkButton } from "@gym/ui";
import { useEffect, useState } from "react";

type Status = {
  status: "CREATED" | "PARTIALLY_PAID" | "PAID" | "EXPIRED" | "CANCELLED";
  amountMinor: number;
  amountPaidMinor: number;
  purpose: string;
  shortUrl: string | null;
};

const inr = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    minor / 100,
  );

/** Polls our server (never trusts the redirect) until the payment is confirmed or we give up. */
export function PaymentStatus({ linkId }: { linkId: string }) {
  const [state, setState] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      tries++;
      try {
        const res = await fetch(`/api/m/payments/${linkId}`, {
          cache: "no-store",
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Couldn't load this payment.");
          return;
        }
        if (stopped) return;
        setState(body);
        if (
          body.status === "PAID" ||
          body.status === "EXPIRED" ||
          body.status === "CANCELLED"
        )
          return;
      } catch {
        /* offline for a moment: keep trying */
      }
      // About 2 minutes of checks, slowing down a little.
      if (tries >= 30) return setGaveUp(true);
      timer = setTimeout(poll, tries < 10 ? 2000 : 5000);
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [linkId]);

  if (error) return <Alert tone="danger">{error}</Alert>;

  if (state?.status === "PAID")
    return (
      <div className="flex flex-col gap-4" role="status">
        <Alert tone="success" title="Payment received">
          {inr(state.amountPaidMinor)} paid.{" "}
          {state.purpose === "BALANCE"
            ? "Your balance is updated."
            : "Your membership is ready."}{" "}
          A receipt is in Payments.
        </Alert>
        <LinkButton href="/m/" size="lg">
          Done
        </LinkButton>
        <LinkButton href="/m/invoices" variant="outline">
          See payments
        </LinkButton>
      </div>
    );

  if (state?.status === "EXPIRED" || state?.status === "CANCELLED")
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title="This payment link is closed">
          No money was taken through it. If you were charged, it will show here
          within a few minutes, or the gym will sort it out.
        </Alert>
        <LinkButton href="/m/invoices">Back to payments</LinkButton>
      </div>
    );

  if (gaveUp)
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="info" title="Still confirming">
          We haven't heard back from the bank yet. If you paid, it will show in
          Payments within a few minutes. Don't pay again.
        </Alert>
        {state?.shortUrl && (
          <p className="text-sm text-muted">
            Didn't finish paying?{" "}
            <a
              className="font-medium text-primary underline"
              href={state.shortUrl}
            >
              Open the payment page again
            </a>
          </p>
        )}
        <LinkButton href="/m/invoices" variant="outline">
          Back to payments
        </LinkButton>
      </div>
    );

  return (
    <div
      className="flex flex-col items-center gap-4 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-10 w-10 animate-spin rounded-full border-4 border-border border-t-primary motion-reduce:animate-none"
        aria-hidden
      />
      <p className="text-lg font-medium">Confirming payment…</p>
      <p className="text-sm text-muted">
        {state?.status === "PARTIALLY_PAID"
          ? `${inr(state.amountPaidMinor)} of ${inr(state.amountMinor)} received so far.`
          : "This usually takes a few seconds. Please don't pay again."}
      </p>
    </div>
  );
}
