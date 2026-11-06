import { listPlans } from "@gym/core/platform";
import {
  ActionForm,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import { createTenantAction } from "../../actions";

export const metadata: Metadata = { title: "Create tenant" };

export default async function NewTenantPage() {
  const { ctx } = await requireAdmin("/tenants/new");
  if (!ctx.permissions.has("platform.tenants.manage")) {
    return <EmptyState title="You don't have permission to create tenants" />;
  }
  const { plans } = await listPlans(services().deps, ctx);
  const active = plans.filter((p) => p.status === "ACTIVE");
  const codes = [...new Map(active.map((p) => [p.code, p])).values()];

  return (
    <>
      <PageHeader
        title="Create a tenant"
        description="The gym starts active on a trial. The owner gets an email to set up their account and first branch."
      />
      <ActionForm
        action={createTenantAction}
        className="flex max-w-xl flex-col gap-4"
      >
        <FormField label="Gym name" name="displayName" required />
        <FormField
          label="Registered business name"
          name="legalName"
          hint="Leave blank if the same."
        />
        <FormField
          label="Owner's email"
          name="ownerEmail"
          type="email"
          required
        />
        <SelectField
          label="Plan"
          name="planCode"
          options={codes.map((p) => ({
            value: p.code,
            label: `${p.name} (${p.code})`,
          }))}
          defaultValue="starter"
          required
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Timezone"
            name="timezone"
            options={["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore"].map(
              (tz) => ({ value: tz, label: tz }),
            )}
            defaultValue="Asia/Kolkata"
          />
          <SelectField
            label="Currency"
            name="currency"
            options={[{ value: "INR", label: "INR" }]}
            defaultValue="INR"
          />
        </div>
        <div>
          <SubmitButton>Create and invite owner</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
