import {
  allowedBranchIds,
  hasPermission,
  isTenantWritable,
  roleLabel,
  STAFF_ROLE_KEYS,
  TENANT_ROLES,
} from "@gym/core/authz";
import { listStaff } from "@gym/core/tenancy";
import {
  ActionForm,
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  inviteStaffAction,
  resendInvitationAction,
  revokeInvitationAction,
  setStaffActiveAction,
} from "../actions";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage({ searchParams }: PageProps<"/staff">) {
  const { ctx, access, user } = await requireReady("/staff");
  if (!hasPermission(ctx, "staff.view")) return <NoAccess />;
  const { staff, invitations } = await listStaff(services().deps, ctx);
  const writable = isTenantWritable(ctx);
  const canInvite = writable && hasPermission(ctx, "staff.invite");
  const canManage = writable && hasPermission(ctx, "staff.manage");
  const tz = ctx.timezone;

  const branchName = new Map(access.branches.map((b) => [b.id, b.name]));
  const roleText = (roles: { roleKey: string; branchId: string | null }[]) =>
    roles
      .map(
        (r) =>
          `${roleLabel(r.roleKey)}${r.branchId ? ` · ${branchName.get(r.branchId) ?? "archived branch"}` : ""}`,
      )
      .join(", ");

  // Offer only roles and branches this user may grant; the server checks again.
  const inviteBranches = allowedBranchIds(ctx, "staff.invite");
  const roleOptions = STAFF_ROLE_KEYS.filter((key) => {
    if (key === "GYM_OWNER") return hasPermission(ctx, "staff.assign_owner");
    if (key === "GYM_ADMIN") return hasPermission(ctx, "staff.assign_admin");
    if (key === "BRANCH_MANAGER")
      return allowedBranchIds(ctx, "staff.manage") === "ALL";
    return true;
  }).map((key) => ({
    value: key,
    label: `${TENANT_ROLES[key].label} – ${TENANT_ROLES[key].description}`,
  }));
  const branchOptions = [
    ...(inviteBranches === "ALL"
      ? [{ value: "all", label: "All branches" }]
      : []),
    ...access.branches
      .filter((b) => inviteBranches === "ALL" || inviteBranches.includes(b.id))
      .map((b) => ({ value: b.id, label: b.name })),
  ];

  return (
    <>
      <PageHeader
        title="Staff"
        description="Who can sign in to this gym, and what they can do."
      />
      <Flash params={await searchParams} />

      {canInvite && (
        <section
          aria-labelledby="invite-heading"
          className="mb-8 rounded-lg border border-border bg-surface p-4 sm:p-6"
        >
          <h2 id="invite-heading" className="mb-4 text-lg font-semibold">
            Invite someone
          </h2>
          <ActionForm
            action={inviteStaffAction}
            resetOnSuccess
            className="grid grid-cols-1 gap-4 md:grid-cols-4 md:items-end"
          >
            <div className="md:col-span-2">
              <FormField
                label="Email"
                name="email"
                type="email"
                autoComplete="off"
                required
              />
            </div>
            <SelectField
              label="Role"
              name="roleKey"
              options={roleOptions}
              placeholder="Choose a role"
              required
            />
            <SelectField
              label="Branch"
              name="branchId"
              options={branchOptions}
              required
            />
            <div className="md:col-span-4">
              <SubmitButton>Send invitation</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      <section aria-labelledby="team-heading" className="mb-8">
        <h2 id="team-heading" className="mb-3 text-lg font-semibold">
          Team
        </h2>
        <DataTable
          caption="Team"
          rows={staff}
          rowKey={(s) => s.membershipId}
          empty={
            <EmptyState
              title="No staff yet"
              description="Invite your first team member above."
            />
          }
          columns={[
            {
              key: "name",
              header: "Name",
              cell: (s) => (
                <div className="flex flex-col">
                  <a
                    className="font-medium text-primary underline"
                    href={`/staff/${s.userId}`}
                  >
                    {s.name}
                  </a>
                  <span className="text-xs text-muted">{s.email}</span>
                </div>
              ),
            },
            { key: "roles", header: "Roles", cell: (s) => roleText(s.roles) },
            {
              key: "status",
              header: "Status",
              cell: (s) =>
                s.status === "ACTIVE" ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="neutral">Deactivated</Badge>
                ),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (s) =>
                canManage && s.userId !== user.id ? (
                  <ConfirmDialog
                    trigger={
                      s.status === "ACTIVE" ? "Remove access" : "Restore access"
                    }
                    title={
                      s.status === "ACTIVE"
                        ? `Remove ${s.name}'s access?`
                        : `Restore ${s.name}'s access?`
                    }
                    description={
                      s.status === "ACTIVE"
                        ? "They are signed out of this gym immediately. Their history stays."
                        : "They can sign in to this gym again with the same roles."
                    }
                    confirmLabel={
                      s.status === "ACTIVE" ? "Remove access" : "Restore access"
                    }
                    confirmVariant={
                      s.status === "ACTIVE" ? "danger" : "primary"
                    }
                    formAction={setStaffActiveAction}
                    fields={{
                      membershipId: s.membershipId,
                      active: s.status === "ACTIVE" ? "false" : "true",
                    }}
                  />
                ) : null,
            },
          ]}
        />
      </section>

      <section aria-labelledby="pending-heading">
        <h2 id="pending-heading" className="mb-3 text-lg font-semibold">
          Pending invitations
        </h2>
        <DataTable
          caption="Pending invitations"
          rows={invitations}
          rowKey={(i) => i.id}
          empty={<EmptyState title="No pending invitations" />}
          columns={[
            { key: "email", header: "Email", cell: (i) => i.email },
            { key: "roles", header: "Roles", cell: (i) => roleText(i.roles) },
            {
              key: "expires",
              header: "Expires",
              hideOnMobile: true,
              cell: (i) =>
                i.expired ? (
                  <Badge tone="warning">Expired</Badge>
                ) : (
                  i.expiresAt.toLocaleDateString("en-IN", {
                    timeZone: tz,
                    dateStyle: "medium",
                  })
                ),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (i) =>
                canInvite ? (
                  <div className="flex flex-wrap gap-2">
                    <ConfirmDialog
                      trigger="Resend"
                      title={`Send the invitation to ${i.email} again?`}
                      description="A new link is emailed; the old one stops working."
                      confirmLabel="Resend"
                      confirmVariant="primary"
                      formAction={resendInvitationAction}
                      fields={{ id: i.id }}
                    />
                    <ConfirmDialog
                      trigger="Cancel"
                      title={`Cancel the invitation to ${i.email}?`}
                      confirmLabel="Cancel invitation"
                      formAction={revokeInvitationAction}
                      fields={{ id: i.id }}
                    />
                  </div>
                ) : null,
            },
          ]}
        />
      </section>
    </>
  );
}
