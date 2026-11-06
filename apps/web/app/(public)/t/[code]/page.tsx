import { trialPassView } from "@gym/core/crm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { QrCode } from "@/components/qr-code";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Trial pass" };

/**
 * A trial pass, linked from the confirmation email. The QR holds only a random code (no personal
 * data); it checks the person in at the trial's branch, on the trial's day, once.
 */
export default async function TrialPassPage({
  params,
}: PageProps<"/t/[code]">) {
  const { code } = await params;
  const pass = await trialPassView(services().db, code);
  if (!pass) notFound();
  const when = pass.startsAt.toLocaleString("en-IN", {
    timeZone: pass.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
  const usable = pass.status === "BOOKED";
  return (
    <main className="mx-auto flex max-w-sm flex-col items-center gap-4 p-6 text-center">
      <p className="text-sm font-semibold text-primary">{pass.gym}</p>
      <h1 className="text-2xl font-semibold">Your trial pass</h1>
      <p>
        {pass.what}
        <br />
        <strong>{when}</strong>
        <br />
        {pass.branch}
        {pass.address ? `, ${pass.address}` : ""}
      </p>
      {usable ? (
        <>
          <QrCode
            value={pass.qr}
            label="Trial pass QR code"
            className="w-64 max-w-full"
          />
          <p className="text-sm text-muted">
            Show this at the front desk when you arrive.
          </p>
        </>
      ) : (
        <p className="rounded-md bg-surface p-3 text-sm">
          {pass.status === "ATTENDED"
            ? "You've checked in. Enjoy!"
            : "This trial was cancelled or has passed. Contact the gym to book again."}
        </p>
      )}
    </main>
  );
}
