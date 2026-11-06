import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listDataRequests } from "@gym/core/members";
import {
  Badge,
  Breadcrumbs,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { completeDeletionAction, rejectDataRequestAction } from "./actions";

export const metadata: Metadata = { title: "Privacy requests" };

const STATUS_TONE = {
  OPEN: "warning",
  DONE: "success",
  REJECTED: "neutral",
} as const;

export default async function PrivacyRequestsPage({
  searchParams,
}: PageProps<"/members/privacy">) {
  const { ctx } = await requireReady("/members/privacy");
  if (!hasPermission(ctx, "members.view")) return <NoAccess />;
  const sp = await searchParams;
  const requests = await listDataRequests(services().deps, ctx);
  const canHandle =
    isTenantWritable(ctx) && hasPermission(ctx, "members.delete");
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: "Privacy requests" },
        ]}
      />
      <PageHeader
        title="Privacy requests"
        description="Members can download their data and ask to be deleted from the app. Deleting removes their personal details; invoices and payments stay for the tax records."
      />
      <Flash params={sp} />
      <DataTable
        caption="Privacy requests"
        rows={requests}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No requests"
            description="Requests from the member app show here."
          />
        }
        columns={[
          {
            key: "member",
            header: "Member",
            cell: (r) =>
              r.member.anonymizedAt ? (
                <span className="text-muted">
                  Deleted member · {r.member.memberCode}
                </span>
              ) : (
                <a
                  className="font-medium text-primary underline"
                  href={`/members/${r.member.id}`}
                >
                  {r.member.name}
                </a>
              ),
          },
          {
            key: "kind",
            header: "Request",
            cell: (r) =>
              r.kind === "DELETION" ? "Delete my data" : "Download my data",
          },
          {
            key: "note",
            header: "Note",
            hideOnMobile: true,
            cell: (r) => <span className="text-sm">{r.note ?? "—"}</span>,
          },
          {
            key: "when",
            header: "Asked",
            hideOnMobile: true,
            cell: (r) => when(r.createdAt, ctx.timezone),
          },
          {
            key: "status",
            header: "Status",
            cell: (r) => (
              <Badge tone={STATUS_TONE[r.status]}>
                {r.status.toLowerCase()}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (r) =>
              canHandle && r.kind === "DELETION" && r.status === "OPEN" ? (
                <span className="flex flex-wrap gap-1">
                  <ConfirmDialog
                    trigger="Delete data"
                    title={`Delete ${r.member.name}'s personal data?`}
                    confirmLabel="Delete personal data"
                    formAction={completeDeletionAction}
                    fields={{ requestId: r.id }}
                  >
                    <p className="text-sm">
                      Their name, phone, email, address, notes and photo are
                      removed, their app access and pass end, and future class
                      bookings are cancelled. This can't be undone. Check any
                      dues first.
                    </p>
                  </ConfirmDialog>
                  <ConfirmDialog
                    trigger="Decline"
                    title="Decline this request?"
                    confirmLabel="Decline"
                    formAction={rejectDataRequestAction}
                    fields={{ requestId: r.id }}
                  >
                    <FormField
                      label="Reason (shown in the audit log)"
                      name="note"
                      required
                      minLength={3}
                    />
                  </ConfirmDialog>
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}
