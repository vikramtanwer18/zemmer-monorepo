import { Alert, LinkButton } from "@gym/ui";
import type { Metadata } from "next";
import { z } from "zod";
import { str } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { PaymentStatus } from "./payment-status";

export const metadata: Metadata = { title: "Confirming payment" };

/**
 * Razorpay sends the member here after checkout. The query string is never trusted: the page
 * only shows what our server has confirmed (webhook or a direct check with Razorpay).
 */
export default async function PaymentReturnPage({
  searchParams,
}: PageProps<"/m/pay/return">) {
  await requireMember("/m/pay/return");
  const id = z.uuid().safeParse(str((await searchParams).link));
  return (
    <>
      <h1 className="text-2xl font-semibold">Payment</h1>
      {id.success ? (
        <PaymentStatus linkId={id.data} />
      ) : (
        <>
          <Alert tone="warning">We couldn't tell which payment this is.</Alert>
          <LinkButton href="/m/invoices">Back to payments</LinkButton>
        </>
      )}
    </>
  );
}
