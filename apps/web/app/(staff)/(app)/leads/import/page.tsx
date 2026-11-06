import { hasPermission } from "@gym/core/authz";
import {
  LEAD_IMPORT_COLUMNS,
  listLeadDataJobs,
  type LeadImportSummary,
} from "@gym/core/crm";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { ImportUploader } from "../../members/data/import-uploader";
import {
  confirmLeadImportAction,
  requestLeadImportUploadAction,
  startLeadImportAction,
} from "../../settings/crm/actions";
import { LeadsTabs } from "../leads-tabs";

export const metadata: Metadata = { title: "Import and export leads" };

export default async function LeadDataPage({
  searchParams,
}: PageProps<"/leads/import">) {
  const { ctx, access } = await requireReady("/leads/import");
  const canImport = hasPermission(ctx, "leads.import");
  const canExport = hasPermission(ctx, "leads.export");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const jobs = await orUpgrade(listLeadDataJobs(services().deps, ctx));
  if (!jobs)
    return <UpgradeNotice title="Import and export" feature="Leads and CRM" />;
  const running = jobs.some(
    (j) => j.status === "PENDING" || j.status === "RUNNING",
  );
  const template = `${LEAD_IMPORT_COLUMNS.join(",")}\r\nRavi,Kumar,9876543210,ravi@example.com,Morning batch,walk_in,,${access.branches[0]?.code ?? "MAIN"},,Called in on Monday\r\n`;
  return (
    <>
      <PageHeader title="Leads" />
      <LeadsTabs current="/leads/import" />
      <Flash params={await searchParams} />
      {running && <meta httpEquiv="refresh" content="3" />}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {canImport ? (
          <section
            aria-labelledby="imp"
            className="rounded-lg border border-border bg-surface p-4"
          >
            <h2 id="imp" className="mb-1 font-semibold">
              Import from CSV
            </h2>
            <p className="mb-3 text-sm text-muted">
              Columns:{" "}
              <code className="text-xs">{LEAD_IMPORT_COLUMNS.join(", ")}</code>.{" "}
              <code className="text-xs">first_name</code> and{" "}
              <code className="text-xs">branch_code</code> (
              {access.branches.map((b) => b.code).join(", ")}) are required,
              plus a mobile or email. A row matching an open lead is added to it
              as a repeat enquiry. We check the whole file first; nothing is
              saved until you choose to import.
            </p>
            <a
              className="mb-3 inline-block text-sm text-primary underline"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
              download="leads-template.csv"
            >
              Download the template
            </a>
            <ImportUploader
              requestImportUploadAction={requestLeadImportUploadAction}
              startImportAction={startLeadImportAction}
            />
          </section>
        ) : (
          <p className="text-sm text-muted">
            Only an owner or admin can import leads.
          </p>
        )}
        {canExport && (
          <section
            aria-labelledby="exp"
            className="rounded-lg border border-border bg-surface p-4"
          >
            <h2 id="exp" className="mb-1 font-semibold">
              Export to CSV
            </h2>
            <p className="mb-3 text-sm text-muted">
              Filter the lead list first, then use &quot;Export these
              leads&quot; under it. Files stay for 24 hours and downloads are
              logged.
            </p>
            <LinkButton href="/leads" variant="outline">
              Go to the list
            </LinkButton>
          </section>
        )}
      </div>
      <h2 className="mb-3 text-lg font-semibold">Your recent jobs</h2>
      <DataTable
        caption="Recent lead import and export jobs"
        rows={jobs}
        rowKey={(j) => j.id}
        empty={<EmptyState title="Nothing yet" />}
        columns={[
          {
            key: "when",
            header: "Started",
            cell: (j) => when(j.createdAt, ctx.timezone),
          },
          {
            key: "kind",
            header: "Job",
            cell: (j) =>
              j.kind === "LEAD_EXPORT"
                ? "Export"
                : j.dryRun
                  ? "Import check"
                  : "Import",
          },
          {
            key: "status",
            header: "Status",
            cell: (j) => (
              <Badge
                tone={
                  j.status === "SUCCEEDED"
                    ? "success"
                    : j.status === "FAILED"
                      ? "danger"
                      : "info"
                }
              >
                {j.status.toLowerCase()}
              </Badge>
            ),
          },
          {
            key: "result",
            header: "Result",
            cell: (j) => {
              const s = j.summary as
                (LeadImportSummary & { count?: number; error?: string }) | null;
              if (!s) return "—";
              if (s.error)
                return <span className="text-danger">{s.error}</span>;
              if (j.kind === "LEAD_EXPORT")
                return j.resultFileId ? (
                  <a
                    className="text-primary underline"
                    href={`/api/exports/${j.id}`}
                  >
                    Download ({s.count} leads)
                  </a>
                ) : null;
              const problems =
                s.rows?.filter((r) => r.status === "error") ?? [];
              return (
                <div className="flex flex-col gap-1 text-sm">
                  <span>
                    {s.imported} new · {s.merged} added to existing · {s.errors}{" "}
                    error(s) of {s.total}
                  </span>
                  {problems.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-primary">
                        Show problems
                      </summary>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {problems.slice(0, 100).map((r) => (
                          <li key={r.row}>
                            Row {r.row}: {r.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {j.dryRun &&
                    j.status === "SUCCEEDED" &&
                    s.imported + s.merged > 0 &&
                    canImport && (
                      <ConfirmDialog
                        trigger={`Import ${s.imported + s.merged} row(s)`}
                        triggerVariant="primary"
                        title={`Import ${s.imported + s.merged} row(s)?`}
                        description="Rows with problems are skipped. Imported leads get a first-contact task each."
                        confirmLabel="Import"
                        confirmVariant="primary"
                        formAction={confirmLeadImportAction}
                        fields={{ jobId: j.id }}
                      />
                    )}
                </div>
              );
            },
          },
        ]}
      />
    </>
  );
}
