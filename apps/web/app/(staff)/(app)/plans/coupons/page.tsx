import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listCoupons, listPlans } from "@gym/core/plans";
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
  Tabs,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day, inr } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveCouponAction, createCouponAction } from "../actions";

export const metadata: Metadata = { title: "Coupons" };

export default async function CouponsPage({
  searchParams,
}: PageProps<"/plans/coupons">) {
  const { ctx } = await requireReady("/plans/coupons");
  if (!hasPermission(ctx, "memberships.view")) return <NoAccess />;
  const { deps } = services();
  const [coupons, plans] = await Promise.all([
    listCoupons(deps, ctx),
    listPlans(deps, ctx),
  ]);
  const canManage = isTenantWritable(ctx) && hasPermission(ctx, "plans.manage");
  return (
    <>
      <PageHeader title="Membership plans" />
      <Tabs
        label="Plans sections"
        current="/plans/coupons"
        items={[
          { href: "/plans", label: "Plans" },
          { href: "/plans/coupons", label: "Coupons" },
        ]}
      />
      <Flash params={await searchParams} />
      {canManage && (
        <section
          aria-labelledby="new-coupon"
          className="mb-8 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="new-coupon" className="mb-3 font-semibold">
            New coupon
          </h2>
          <ActionForm
            action={createCouponAction}
            resetOnSuccess
            className="grid grid-cols-1 gap-3 md:grid-cols-4 md:items-start"
          >
            <FormField label="Code" name="code" required />
            <SelectField
              label="Type"
              name="kind"
              options={[
                { value: "PERCENT", label: "Percentage" },
                { value: "FLAT", label: "Fixed amount" },
              ]}
            />
            <FormField
              label="Percent off"
              name="percent"
              inputMode="decimal"
              hint="For percentage coupons."
            />
            <FormField
              label="Amount off (₹)"
              name="amount"
              inputMode="decimal"
              hint="For fixed-amount coupons."
            />
            <FormField label="Valid from" name="validFrom" type="date" />
            <FormField label="Valid until" name="validTo" type="date" />
            <FormField
              label="Max uses"
              name="maxRedemptions"
              type="number"
              min={1}
              hint="Empty = unlimited."
            />
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Plans (none = all)</span>
              {plans.map((p) => (
                <label key={p.code} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="planCodes"
                    value={p.code}
                    className="size-4 accent-primary"
                  />
                  {p.name}
                </label>
              ))}
            </div>
            <div className="md:col-span-4">
              <SubmitButton variant="outline">Create coupon</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
      <DataTable
        caption="Coupons"
        rows={coupons}
        rowKey={(c) => c.id}
        empty={<EmptyState title="No coupons" />}
        columns={[
          { key: "code", header: "Code", cell: (c) => <code>{c.code}</code> },
          {
            key: "value",
            header: "Discount",
            cell: (c) =>
              c.kind === "PERCENT" ? `${c.value / 100}%` : inr(c.value),
          },
          {
            key: "valid",
            header: "Valid",
            hideOnMobile: true,
            cell: (c) =>
              `${c.validFrom ? day(c.validFrom) : "any time"} – ${c.validTo ? day(c.validTo) : "no end"}`,
          },
          {
            key: "uses",
            header: "Used",
            cell: (c) =>
              `${c.redemptions}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}`,
          },
          {
            key: "status",
            header: "Status",
            cell: (c) =>
              c.status === "ACTIVE" ? (
                <Badge tone="success">Active</Badge>
              ) : (
                <Badge>Archived</Badge>
              ),
          },
          {
            key: "a",
            header: "",
            cell: (c) =>
              canManage ? (
                <ConfirmDialog
                  trigger={c.status === "ACTIVE" ? "Archive" : "Restore"}
                  title={`${c.status === "ACTIVE" ? "Archive" : "Restore"} ${c.code}?`}
                  confirmLabel="Confirm"
                  confirmVariant="primary"
                  formAction={archiveCouponAction}
                  fields={{
                    couponId: c.id,
                    archived: c.status === "ACTIVE" ? "true" : "false",
                  }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
