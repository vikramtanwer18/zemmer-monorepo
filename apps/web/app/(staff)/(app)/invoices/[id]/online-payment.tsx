import {
  hasPermission,
  isTenantWritable,
  type AuthContext,
} from "@gym/core/authz";
import { getPaymentIntegration, listPaymentLinks } from "@gym/core/payments";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  FormField,
  SubmitButton,
} from "@gym/ui";
import { inr, when } from "@/lib/format";
import { services } from "@/lib/services";
import { cancelLinkAction, sendLinkAction } from "../../payments/links/actions";
import { CopyButton } from "./copy-button";

const TONE = {
  CREATED: "info",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  EXPIRED: "neutral",
  CANCELLED: "neutral",
} as const;

/** "Send payment link" and the links already sent for this invoice. */
export async function OnlinePaymentPanel({
  ctx,
  invoiceId,
  branchId,
  outstandingMinor,
  open,
}: {
  ctx: AuthContext;
  invoiceId: string;
  branchId: string;
  outstandingMinor: number;
  open: boolean;
}) {
  const { deps } = services();
  const [integration, links] = [
    await getPaymentIntegration(deps, ctx),
    await listPaymentLinks(deps, ctx, { invoiceId }),
  ];
  const canSend =
    open &&
    !!integration &&
    isTenantWritable(ctx) &&
    hasPermission(ctx, "billing.collect", { branchId });
  if (!integration && links.length === 0) return null;
  return (
    <Card className="mt-6 flex flex-col gap-4">
      <CardTitle>Online payment</CardTitle>
      {links.length > 0 && (
        <ul
          className="flex flex-col divide-y divide-border text-sm"
          data-testid="payment-links"
        >
          {links.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="flex flex-col">
                <span>
                  {inr(l.amountMinor)}
                  {l.acceptPartial ? " (part payments allowed)" : ""} ·{" "}
                  <Badge tone={TONE[l.status]}>
                    {l.status.replace("_", " ").toLowerCase()}
                  </Badge>
                </span>
                <span className="text-xs text-muted">
                  Sent {when(l.createdAt, ctx.timezone)}
                  {l.amountPaidMinor ? ` · ${inr(l.amountPaidMinor)} paid` : ""}
                  {l.expiresAt
                    ? ` · expires ${when(l.expiresAt, ctx.timezone)}`
                    : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {l.shortUrl &&
                  (l.status === "CREATED" || l.status === "PARTIALLY_PAID") && (
                    <CopyButton text={l.shortUrl} />
                  )}
                {l.canCancel && (
                  <form action={cancelLinkAction}>
                    <input type="hidden" name="linkId" value={l.id} />
                    <input
                      type="hidden"
                      name="back"
                      value={`/invoices/${invoiceId}`}
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      Cancel link
                    </Button>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canSend && (
        <ActionForm action={sendLinkAction} className="flex flex-col gap-3">
          <input type="hidden" name="invoiceIds" value={invoiceId} />
          <CheckboxField name="acceptPartial" label="Allow part payments" />
          <FormField
            label="Smallest part payment (₹)"
            name="minPartial"
            inputMode="decimal"
            placeholder={String(Math.min(500, outstandingMinor / 100))}
          />
          <CheckboxField
            name="sendEmail"
            label="Email the link to the member"
            defaultChecked
          />
          <div>
            <SubmitButton>
              Send payment link for {inr(outstandingMinor)}
            </SubmitButton>
          </div>
        </ActionForm>
      )}
    </Card>
  );
}
