import { hasPermission } from "@gym/core/authz";
import { IMPORT_COLUMNS, type ImportSummary } from "@gym/core/members";
import { withTenant } from "@gym/db";
import {
  Badge,
  Breadcrumbs,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { exportMembersAction, runImportForRealAction } from "../actions";
import { ImportUploader } from "./import-uploader";

export const metadata: Metadata = { title: "Import and export members" };

export default async function MemberDataPage({
  searchParams,
}: PageProps<"/members/data">) {
  const { ctx, access } = await requireReady("/members/data");
  const canImport = hasPermission(ctx, "members.import");
  const canExport = hasPermission(ctx, "members.export");
  if (!canImport && !canExport) return <NoAccess />;
  const jobs = await withTenant(services().db, ctx.tenantId, (tx) =>
    tx.dataJob.findMany({
      where: { kind: { in: ["MEMBER_IMPORT", "MEMBER_EXPORT"] } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  );
  const running = jobs.some(
    (j) => j.status === "PENDING" || j.status === "RUNNING",
  );

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: "Import / export" },
        ]}
      />
      <PageHeader title="Import and export members" />
      <Flash params={await searchParams} />
      {running && <meta httpEquiv="refresh" content="3" />}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {canImport && (
          <section
            aria-labelledby="imp"
            className="rounded-lg border border-border bg-surface p-4"
          >
            <h2 id="imp" className="mb-1 font-semibold">
              Import from CSV
            </h2>
            <p className="mb-3 text-sm text-muted">
              Columns:{" "}
              <code className="text-xs">{IMPORT_COLUMNS.join(", ")}</code>.{" "}
              <code className="text-xs">first_name</code> and{" "}
              <code className="text-xs">branch_code</code> (
              {access.branches.map((b) => b.code).join(", ")}) are required,
              plus a phone or email. We check the file first and show every
              problem; nothing is saved until you choose to import.
            </p>
            <a
              className="mb-3 inline-block text-sm text-primary underline"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(`${IMPORT_COLUMNS.join(",")}\r\nAsha,Verma,9876543210,asha@example.com,1995-04-12,FEMALE,${access.branches[0]?.code ?? "MAIN"},yes,no\r\n`)}`}
              download="members-template.csv"
            >
              Download the template
            </a>
            <ImportUploader />
          </section>
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
              Prepared in the background. The file stays available for 24 hours,
              and every download is logged.
            </p>
            <form
              action={exportMembersAction}
              className="flex flex-wrap items-end gap-2"
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Members
                <select
                  name="status"
                  className="h-10 rounded-md border border-border bg-surface px-2 font-normal"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="all">All, incl. archived</option>
                </select>
              </label>
              <button
                type="submit"
                className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Start export
              </button>
            </form>
          </section>
        )}
      </div>
      <h2 className="mb-3 text-lg font-semibold">Recent jobs</h2>
      <DataTable
        caption="Recent import and export jobs"
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
              j.kind === "MEMBER_EXPORT"
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
                (ImportSummary & { count?: number; error?: string }) | null;
              if (!s) return "—";
              if (s.error)
                return <span className="text-danger">{s.error}</span>;
              if (j.kind === "MEMBER_EXPORT") {
                return j.resultFileId ? (
                  <a
                    className="text-primary underline"
                    href={`/api/exports/${j.id}`}
                  >
                    Download ({s.count} members)
                  </a>
                ) : null;
              }
              const problems = s.rows?.filter((r) => r.status !== "ok") ?? [];
              return (
                <div className="flex flex-col gap-1 text-sm">
                  <span>
                    {s.imported} {j.dryRun ? "ready" : "imported"} · {s.errors}{" "}
                    error(s) · {s.duplicates} duplicate(s) of {s.total}
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
                    s.imported > 0 &&
                    canImport && (
                      <ConfirmDialog
                        trigger={`Import ${s.imported} member(s)`}
                        triggerVariant="primary"
                        title={`Import ${s.imported} member(s)?`}
                        description="Rows with problems are skipped. Members are created with service-message consent; marketing only where the file says yes."
                        confirmLabel="Import"
                        confirmVariant="primary"
                        formAction={runImportForRealAction}
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
