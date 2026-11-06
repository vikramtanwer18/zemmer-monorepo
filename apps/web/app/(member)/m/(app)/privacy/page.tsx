import { getMyHealthConsent } from "@gym/core/fitness";
import { getMyPrivacy } from "@gym/core/members";
import {
  Alert,
  Card,
  CardTitle,
  ConfirmDialog,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { str, when } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import { healthConsentAction } from "../workouts/actions";
import { acceptPrivacyAction, requestDeletionAction } from "./actions";

export const metadata: Metadata = { title: "Privacy" };

/**
 * Privacy notice (DPDP Act 2023 launch minimum). The wording is a plain-language starting point;
 * each gym's own legal review is listed in the pilot checklist.
 */
export default async function MemberPrivacyPage({
  searchParams,
}: PageProps<"/m/privacy">) {
  const { mctx } = await requireMember("/m/privacy");
  const sp = await searchParams;
  const privacy = await getMyPrivacy(services().deps, mctx);
  const health = await getMyHealthConsent(services().deps, mctx);
  const next = str(sp.next);
  return (
    <>
      <h1 className="text-2xl font-semibold">Privacy and your data</h1>
      <Flash params={sp} />
      <Card>
        <CardTitle>How {mctx.tenantName} uses your data</CardTitle>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p>
            We keep your name, phone, email, date of birth, emergency contact,
            photo (if you give one), memberships, payments, check-ins and class
            bookings.
          </p>
          <p>
            We use them to run your membership: check you in, take payments,
            send receipts and service messages (renewals, class changes, dues).
            Offers and promotions are sent only if you agree to them in Profile,
            and you can stop them at any time.
          </p>
          <p>
            Online payments are handled by Razorpay. We never see or store your
            card details. Your data is not sold.
          </p>
          <p>
            You can download a copy of your data below, and ask us to delete it.
            We keep invoices and payment records for as long as tax law
            requires, even after deletion.
          </p>
          <p className="text-xs text-muted">Notice version {privacy.version}</p>
        </div>
        {privacy.accepted ? (
          <p className="mt-4 text-sm text-muted">
            You accepted this on{" "}
            {privacy.acceptedAt ? when(privacy.acceptedAt, mctx.timezone) : "—"}
            .
          </p>
        ) : (
          <form action={acceptPrivacyAction} className="mt-4">
            <input type="hidden" name="next" value={next ?? "/m/"} />
            <SubmitButton size="lg" className="w-full">
              I understand, continue
            </SubmitButton>
          </form>
        )}
      </Card>

      <Card data-testid="health-privacy">
        <CardTitle>Fitness and health data</CardTitle>
        <p className="mt-2 text-sm">{health.text}</p>
        <form action={healthConsentAction} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="back" value="/m/privacy" />
          {health.granted ? (
            <>
              <p className="text-sm text-muted">
                You agreed on {when(health.at, mctx.timezone)}.
              </p>
              <div>
                <SubmitButton variant="outline">Withdraw</SubmitButton>
              </div>
            </>
          ) : (
            <>
              <input type="hidden" name="granted" value="on" />
              <div>
                <SubmitButton>I agree</SubmitButton>
              </div>
            </>
          )}
        </form>
      </Card>
      <Card>
        <CardTitle>Your data</CardTitle>
        <a
          className="mt-3 inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-medium"
          href="/api/m/data-export"
          download
        >
          Download my data
        </a>
        <div className="mt-4 border-t border-border pt-4">
          {privacy.deletionRequestedAt ? (
            <Alert tone="info">
              You asked for your data to be deleted on{" "}
              {when(privacy.deletionRequestedAt, mctx.timezone)}. The gym will
              contact you.
            </Alert>
          ) : (
            <ConfirmDialog
              trigger="Ask to delete my data"
              title="Ask the gym to delete your data?"
              confirmLabel="Send request"
              formAction={requestDeletionAction}
            >
              <p className="text-sm">
                The gym will check for any dues, then remove your personal
                details and end your app access and membership pass. Invoices
                and payments are kept for tax records.
              </p>
              <TextareaField
                label="Anything to add (optional)"
                name="note"
                rows={2}
              />
            </ConfirmDialog>
          )}
        </div>
      </Card>
    </>
  );
}
