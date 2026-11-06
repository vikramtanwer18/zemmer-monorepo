import { publicFormView } from "@gym/core/crm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { str } from "@/lib/format";
import { services } from "@/lib/services";
import { LeadForm } from "./lead-form";

export const metadata: Metadata = { title: "Enquiry" };

const TRACKING = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrer",
] as const;

/** Hosted enquiry form: /l/{gym}/{form}. UTM tags in the link are kept with the lead. */
export default async function PublicLeadFormPage({
  params,
  searchParams,
}: PageProps<"/l/[tenant]/[key]">) {
  const { tenant, key } = await params;
  const sp = await searchParams;
  const view = await publicFormView(services().deps, tenant, key);
  if (!view) notFound();
  const tracking = Object.fromEntries(
    TRACKING.map((k) => [k, str(sp[k])?.slice(0, 300)]).filter(
      (e): e is [string, string] => !!e[1],
    ),
  );
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-4 py-8">
      <p className="text-sm font-semibold text-primary">
        {view.tenantName} · {view.branchName}
      </p>
      <h1 className="text-2xl font-semibold">{view.title}</h1>
      {view.intro && <p className="text-muted">{view.intro}</p>}
      <LeadForm
        tenant={tenant}
        formKey={key}
        fields={view.fields}
        consentText={view.consentText}
        marketingText={view.marketingText}
        tracking={tracking}
      />
      <p className="text-xs text-muted">
        Your details go only to {view.tenantName}, to answer your enquiry.
      </p>
    </main>
  );
}
