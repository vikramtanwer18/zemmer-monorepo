import { isAppError } from "@gym/core/errors";
import { roleLabel } from "@gym/core/authz";
import { GST_STATES } from "@gym/core/gst";
import { getSupportSnapshot } from "@gym/core/platform";
import {
  Alert,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { endSupportAction } from "../../actions";

export const metadata: Metadata = { title: "Support session" };

export default async function SupportSessionPage({
  params,
}: PageProps<"/support/[id]">) {
  const { id } = await params;
  const { ctx } = await requireAdmin(`/support/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await getSupportSnapshot(services().deps, ctx, id).catch(
    (err) => {
      if (isAppError(err) && err.code === "NOT_FOUND") notFound();
      if (isAppError(err) && err.code === "FORBIDDEN") return null;
      throw err;
    },
  );
  if (!result || !result.snapshot) {
    return (
      <EmptyState
        title="This support session has ended"
        description="Open a new one from the tenant's page."
      />
    );
  }
  const { session, snapshot } = result;
  const settings = snapshot.settings as Record<string, unknown> | null;

  return (
    <>
      <PageHeader
        title={`Support: ${session.tenant.displayName}`}
        description={`Read-only until ${session.expiresAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" })}. Reason: ${session.reason}`}
        actions={
          <ConfirmDialog
            trigger="End session"
            title="End this support session?"
            confirmLabel="End session"
            formAction={endSupportAction}
            fields={{ sessionId: session.id }}
          />
        }
      />
      <Alert tone="info" className="mb-6">
        Settings and counts only. Member records are never shown here. This view
        is logged.
      </Alert>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Branches" value={snapshot.branches.length} />
        <StatCard
          label="Pending invitations"
          value={snapshot.pendingInvitations}
        />
        {Object.entries(snapshot.activeMembershipsByRole).map(([role, n]) => (
          <StatCard key={role} label={roleLabel(role)} value={n} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Settings</CardTitle>
          {settings ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">GST registered</dt>
              <dd>{settings.gstRegistered ? "Yes" : "No"}</dd>
              <dt className="text-muted">GSTIN</dt>
              <dd>{(settings.gstin as string | null) ?? "—"}</dd>
              <dt className="text-muted">State</dt>
              <dd>{GST_STATES[settings.stateCode as string] ?? "—"}</dd>
              <dt className="text-muted">Prices include tax</dt>
              <dd>{settings.pricesIncludeTax ? "Yes" : "No"}</dd>
              <dt className="text-muted">Staff 2FA required</dt>
              <dd>{settings.require2faForStaff ? "Yes" : "No"}</dd>
              <dt className="text-muted">Logo</dt>
              <dd>{settings.hasLogo ? "Uploaded" : "None"}</dd>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted">
              The owner hasn&apos;t finished setup.
            </p>
          )}
        </Card>
        <div>
          <h2 className="mb-3 text-lg font-semibold">Branches</h2>
          <DataTable
            caption="Branches"
            rows={snapshot.branches}
            rowKey={(b) => b.code}
            empty={<EmptyState title="No branches yet" />}
            columns={[
              {
                key: "name",
                header: "Name",
                cell: (b) => `${b.name} (${b.code})`,
              },
              {
                key: "place",
                header: "Place",
                cell: (b) =>
                  [b.city, GST_STATES[b.stateCode]].filter(Boolean).join(", "),
              },
              {
                key: "status",
                header: "Status",
                cell: (b) => b.status.toLowerCase(),
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
