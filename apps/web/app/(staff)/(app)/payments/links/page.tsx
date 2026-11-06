import { hasPermission } from "@gym/core/authz";
import { listPaymentLinks } from "@gym/core/payments";
import { Badge, Button, DataTable, EmptyState, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { inr, str, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { CopyButton } from "../../invoices/[id]/copy-button";
import { PaymentsTabs } from "../payments-tabs";
import { cancelLinkAction, recheckLinkAction } from "./actions";

export const metadata: Metadata = { title: "Payment links" };

const TONE = {
  CREATED: "info",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  EXPIRED: "neutral",
  CANCELLED: "neutral",
} as const;
const PURPOSE = {
  INVOICES: "Sent by staff",
  BALANCE: "Balance (app)",
  RENEWAL: "Renewal (app)",
  PURCHASE: "New plan (app)",
} as const;

export default async function PaymentLinksPage({
  searchParams,
}: PageProps<"/payments/links">) {
  const { ctx } = await requireReady("/payments/links");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const status = str(sp.status) === "open" ? "open" : "all";
  const links = await listPaymentLinks(services().deps, ctx, { status });
  return (
    <>
      <PageHeader
        title="Payments"
        description="Online payment links: sent by staff, or created when members pay, renew or buy in the app."
      />
      <PaymentsTabs current="/payments/links" />
      <Flash params={sp} />
      <div className="mb-4 flex gap-2 text-sm">
        <a
          className={`rounded-md border px-3 py-1.5 ${status === "all" ? "border-primary" : "border-border"}`}
          href="/payments/links"
        >
          All
        </a>
        <a
          className={`rounded-md border px-3 py-1.5 ${status === "open" ? "border-primary" : "border-border"}`}
          href="/payments/links?status=open"
        >
          Waiting for payment
        </a>
      </div>
      <DataTable
        caption="Payment links"
        rows={links}
        rowKey={(l) => l.id}
        empty={
          <EmptyState
            title="No payment links"
            description="Send one from an invoice."
          />
        }
        columns={[
          {
            key: "member",
            header: "Member",
            cell: (l) => (
              <a
                className="font-medium text-primary underline"
                href={`/members/${l.member.id}?tab=billing`}
              >
                {l.member.name}
              </a>
            ),
          },
          {
            key: "amount",
            header: "Amount",
            cell: (l) => (
              <span>
                {inr(l.amountMinor)}
                {l.amountPaidMinor > 0 && l.amountPaidMinor < l.amountMinor && (
                  <span className="block text-xs text-muted">
                    {inr(l.amountPaidMinor)} paid
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "for",
            header: "For",
            hideOnMobile: true,
            cell: (l) => `${PURPOSE[l.purpose]} · ${l.invoices.join(", ")}`,
          },
          {
            key: "when",
            header: "Created",
            hideOnMobile: true,
            cell: (l) => when(l.createdAt, ctx.timezone),
          },
          {
            key: "status",
            header: "Status",
            cell: (l) => (
              <Badge tone={TONE[l.status]}>
                {l.status.replace("_", " ").toLowerCase()}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (l) => (
              <span className="flex flex-wrap gap-1">
                {l.shortUrl &&
                  (l.status === "CREATED" || l.status === "PARTIALLY_PAID") && (
                    <CopyButton text={l.shortUrl} />
                  )}
                <form action={recheckLinkAction}>
                  <input type="hidden" name="linkId" value={l.id} />
                  <input type="hidden" name="back" value="/payments/links" />
                  <Button type="submit" size="sm" variant="ghost">
                    Re-check
                  </Button>
                </form>
                {l.canCancel && (
                  <form action={cancelLinkAction}>
                    <input type="hidden" name="linkId" value={l.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      Cancel
                    </Button>
                  </form>
                )}
              </span>
            ),
          },
        ]}
      />
    </>
  );
}
