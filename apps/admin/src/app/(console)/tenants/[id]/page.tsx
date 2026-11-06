import { isAppError } from "@gym/core/errors";
import { FEATURES } from "@gym/core/entitlements";
import {
  getTenantDetail,
  listPlans,
  SUPPORT_MAX_MINUTES,
} from "@gym/core/platform";
import {
  ActionForm,
  Alert,
  Badge,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import {
  addOverrideAction,
  changePlanAction,
  removeOverrideAction,
  resendOwnerInviteAction,
  startSupportAction,
  tenantStatusAction,
} from "../../actions";
import { StatusBadge } from "../status-badge";

export const metadata: Metadata = { title: "Tenant" };

const fmt = (d: Date | null | undefined) =>
  d
    ? d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

export default async function TenantPage({
  params,
  searchParams,
}: PageProps<"/tenants/[id]">) {
  const { id } = await params;
  const { ctx } = await requireAdmin(`/tenants/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { deps } = services();
  const detail = await getTenantDetail(deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  });
  const { tenant, owners, audit } = detail;
  const { plans } = await listPlans(deps, ctx);
  const sp = await searchParams;
  const canManage = ctx.permissions.has("platform.tenants.manage");
  const canPlans = ctx.permissions.has("platform.plans.manage");
  const canSupport = ctx.permissions.has("platform.support.access");
  const reasonField = (
    <TextareaField label="Reason" name="reason" required minLength={5} />
  );

  return (
    <>
      <PageHeader
        title={tenant.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {tenant.slug} <StatusBadge status={tenant.status} />
          </span>
        }
        actions={
          canManage && (
            <>
              {tenant.status === "PENDING_APPROVAL" && (
                <ConfirmDialog
                  trigger="Approve"
                  triggerVariant="primary"
                  title={`Approve ${tenant.displayName}?`}
                  description="The tenant becomes active and its trial starts now."
                  confirmLabel="Approve"
                  confirmVariant="primary"
                  formAction={tenantStatusAction}
                  fields={{ tenantId: tenant.id, change: "approve" }}
                />
              )}
              {(tenant.status === "ACTIVE" ||
                tenant.status === "PENDING_APPROVAL") && (
                <ConfirmDialog
                  trigger="Suspend"
                  title={`Suspend ${tenant.displayName}?`}
                  description="Staff can still sign in and read their data but cannot change anything. Nothing is deleted."
                  confirmLabel="Suspend"
                  formAction={tenantStatusAction}
                  fields={{ tenantId: tenant.id, change: "suspend" }}
                >
                  {reasonField}
                </ConfirmDialog>
              )}
              {tenant.status === "SUSPENDED" && (
                <ConfirmDialog
                  trigger="Reactivate"
                  triggerVariant="primary"
                  title={`Reactivate ${tenant.displayName}?`}
                  confirmLabel="Reactivate"
                  confirmVariant="primary"
                  formAction={tenantStatusAction}
                  fields={{ tenantId: tenant.id, change: "reactivate" }}
                >
                  {reasonField}
                </ConfirmDialog>
              )}
            </>
          )
        }
      />
      {typeof sp.notice === "string" && (
        <Alert tone="success" className="mb-4">
          {sp.notice}
        </Alert>
      )}
      {typeof sp.error === "string" && (
        <Alert tone="danger" className="mb-4">
          {sp.error}
        </Alert>
      )}
      {tenant.statusReason && (
        <Alert tone="warning" className="mb-4" title="Status reason">
          {tenant.statusReason}
        </Alert>
      )}

      <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle>Profile</CardTitle>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Legal name</dt>
            <dd>{tenant.legalName}</dd>
            <dt className="text-muted">Country</dt>
            <dd>{tenant.country}</dd>
            <dt className="text-muted">Timezone</dt>
            <dd>{tenant.timezone}</dd>
            <dt className="text-muted">Currency</dt>
            <dd>{tenant.currency}</dd>
            <dt className="text-muted">Created</dt>
            <dd>{fmt(tenant.createdAt)}</dd>
          </dl>
        </Card>
        <Card>
          <CardTitle>Subscription</CardTitle>
          {tenant.subscription ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Plan</dt>
              <dd>
                {tenant.subscription.plan.name} v
                {tenant.subscription.plan.version}
              </dd>
              <dt className="text-muted">Status</dt>
              <dd>
                <Badge>{tenant.subscription.status.toLowerCase()}</Badge>
              </dd>
              <dt className="text-muted">Trial ends</dt>
              <dd>{fmt(tenant.subscription.trialEndsAt)}</dd>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted">No subscription.</p>
          )}
          {canPlans && tenant.subscription && (
            <form
              action={changePlanAction}
              className="mt-4 flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="tenantId" value={tenant.id} />
              <label htmlFor="planId" className="sr-only">
                Plan
              </label>
              <select
                id="planId"
                name="planId"
                defaultValue={tenant.subscription.planId}
                className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
              >
                {plans
                  .filter((p) => p.status === "ACTIVE")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} v{p.version}
                    </option>
                  ))}
              </select>
              <button
                type="submit"
                className="h-9 rounded-md border border-border px-3 text-sm hover:bg-background"
              >
                Change plan
              </button>
            </form>
          )}
        </Card>
        <Card>
          <CardTitle>Usage</CardTitle>
          {tenant.usageCounters.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing counted yet.</p>
          ) : (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {tenant.usageCounters.map((u) => (
                <div key={u.key} className="contents">
                  <dt className="text-muted">{u.key}</dt>
                  <dd>{u.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <section aria-labelledby="owners-heading" className="mb-8">
        <h2 id="owners-heading" className="mb-3 text-lg font-semibold">
          Owners
        </h2>
        {owners.length === 0 ? (
          <EmptyState
            title="No owner has accepted yet"
            description="Resend the owner invitation below if needed."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {owners.map((o) => (
              <li key={o.email}>
                {o.name} · {o.email}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            action={resendOwnerInviteAction}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="owner-email" className="text-sm font-medium">
                Invite an owner
              </label>
              <input
                id="owner-email"
                name="email"
                type="email"
                required
                className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
              />
            </div>
            <button
              type="submit"
              className="h-9 rounded-md border border-border px-3 text-sm hover:bg-background"
            >
              Send owner invitation
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="overrides-heading" className="mb-8">
        <h2 id="overrides-heading" className="mb-3 text-lg font-semibold">
          Feature overrides
        </h2>
        <DataTable
          caption="Feature overrides"
          rows={tenant.overrides}
          rowKey={(o) => o.id}
          empty={
            <EmptyState
              title="No overrides"
              description="This tenant gets exactly its plan."
            />
          }
          columns={[
            {
              key: "feature",
              header: "Feature",
              cell: (o) => <code className="text-xs">{o.featureKey}</code>,
            },
            {
              key: "value",
              header: "Value",
              cell: (o) => JSON.stringify(o.value ?? null),
            },
            {
              key: "expires",
              header: "Expires",
              cell: (o) => (o.expiresAt ? fmt(o.expiresAt) : "Never"),
            },
            {
              key: "reason",
              header: "Reason",
              hideOnMobile: true,
              cell: (o) => o.reason,
            },
            {
              key: "remove",
              header: "",
              cell: (o) =>
                canPlans ? (
                  <ConfirmDialog
                    trigger="Remove"
                    title="Remove this override?"
                    confirmLabel="Remove"
                    formAction={removeOverrideAction}
                    fields={{ tenantId: tenant.id, overrideId: o.id }}
                  />
                ) : null,
            },
          ]}
        />
        {canPlans && (
          <ActionForm
            action={addOverrideAction}
            resetOnSuccess
            className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4 md:items-start"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <SelectField
              label="Feature"
              name="featureKey"
              options={Object.entries(FEATURES).map(([key, type]) => ({
                value: key,
                label: `${key} (${type.toLowerCase()})`,
              }))}
              required
            />
            <FormField
              label="Value"
              name="value"
              hint="true/false, a number, or 'unlimited'"
              required
            />
            <FormField
              label="Expires (optional)"
              name="expiresAt"
              type="datetime-local"
            />
            <FormField label="Reason" name="reason" required />
            <div className="md:col-span-4">
              <SubmitButton variant="outline">Add override</SubmitButton>
            </div>
          </ActionForm>
        )}
      </section>

      {canSupport && (
        <section
          aria-labelledby="support-heading"
          className="mb-8 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="support-heading" className="mb-1 text-lg font-semibold">
            Support access
          </h2>
          <p className="mb-3 text-sm text-muted">
            Read-only view of settings and counts (no member records), for at
            most {SUPPORT_MAX_MINUTES / 60} hours. Logged here and in the
            tenant&apos;s own audit log; the tenant sees a notice while it is
            open.
          </p>
          <ActionForm
            action={startSupportAction}
            className="grid grid-cols-1 gap-3 md:grid-cols-3 md:items-end"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <div className="md:col-span-2">
              <FormField
                label="Reason"
                name="reason"
                placeholder="Ticket #123: owner can't see branch"
                required
              />
            </div>
            <SelectField
              label="Duration"
              name="minutes"
              options={[
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
                { value: "120", label: "2 hours" },
              ]}
              defaultValue="30"
            />
            <div className="md:col-span-3">
              <SubmitButton variant="outline">
                Open support session
              </SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}

      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="mb-3 text-lg font-semibold">
          Recent platform actions
        </h2>
        <DataTable
          caption="Recent platform actions"
          rows={audit}
          rowKey={(a) => a.id}
          empty={<EmptyState title="Nothing yet" />}
          columns={[
            { key: "when", header: "When", cell: (a) => fmt(a.createdAt) },
            {
              key: "who",
              header: "Who",
              cell: (a) => a.actor?.email ?? "System",
            },
            {
              key: "action",
              header: "Action",
              cell: (a) => <code className="text-xs">{a.action}</code>,
            },
          ]}
        />
      </section>
    </>
  );
}
