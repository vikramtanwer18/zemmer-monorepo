import { hasPermission } from "@gym/core/authz";
import { listInvoices } from "@gym/core/billing";
import { DataTable, EmptyState, PageHeader, Pagination, Tabs } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { day, inr, str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { InvoiceBadge } from "@/components/invoice-badge";

export const metadata: Metadata = { title: "Invoices" };

export default async function InvoicesPage({
  searchParams,
}: PageProps<"/invoices">) {
  const { ctx } = await requireReady("/invoices");
  if (!hasPermission(ctx, "billing.view")) return <NoAccess />;
  const sp = await searchParams;
  const status = str(sp.status) ?? "all";
  const filters = {
    status,
    from: str(sp.from),
    to: str(sp.to),
    branchId: str(sp.branchId),
    page: str(sp.page) ?? "1",
  };
  const result = await listInvoices(services().deps, ctx, filters);
  const href = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...o }))
      if (v) p.set(k, v);
    return `/invoices?${p}`;
  };
  return (
    <>
      <PageHeader title="Invoices" description={`${result.total} invoice(s)`} />
      <Tabs
        label="Invoice status"
        current={href({ page: undefined })}
        items={[
          ["all", "All"],
          ["open", "Open"],
          ["paid", "Paid"],
          ["void", "Void / cancelled"],
        ].map(([v, l]) => ({
          href: href({ status: v, page: undefined }),
          label: l!,
        }))}
      />
      <DataTable
        caption="Invoices"
        rows={result.rows}
        rowKey={(i) => i.id}
        empty={
          <EmptyState
            title="No invoices"
            description="Invoices appear when you sell a membership."
          />
        }
        columns={[
          {
            key: "number",
            header: "Number",
            cell: (i) => (
              <a
                className="font-medium text-primary underline"
                href={`/invoices/${i.id}`}
              >
                {i.number}
              </a>
            ),
          },
          {
            key: "member",
            header: "Member",
            cell: (i) =>
              `${i.member.firstName} ${i.member.lastName ?? ""} · ${i.member.memberCode}`,
          },
          {
            key: "date",
            header: "Date",
            hideOnMobile: true,
            cell: (i) => day(i.issueDate),
          },
          { key: "total", header: "Total", cell: (i) => inr(i.totalMinor) },
          {
            key: "due",
            header: "Due",
            cell: (i) => inr(i.balance.outstandingMinor),
          },
          {
            key: "status",
            header: "Status",
            cell: (i) => <InvoiceBadge status={i.status} />,
          },
        ]}
      />
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        hrefFor={(p) => href({ page: String(p) })}
      />
    </>
  );
}
