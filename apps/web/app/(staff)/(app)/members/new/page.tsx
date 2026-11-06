import { hasPermission } from "@gym/core/authz";
import {
  ActionForm,
  Breadcrumbs,
  CheckboxField,
  PageHeader,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { requireReady } from "@/lib/session";
import { createMemberAction } from "../actions";
import { MemberFields } from "../member-fields";

export const metadata: Metadata = { title: "Add member" };

export default async function NewMemberPage() {
  const { ctx, access } = await requireReady("/members/new");
  if (!hasPermission(ctx, "members.create")) return <NoAccess />;
  const branches = access.branches.filter((b) =>
    hasPermission(ctx, "members.create", { branchId: b.id }),
  );

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: "Add member" },
        ]}
      />
      <PageHeader title="Add a member" />
      <ActionForm
        action={createMemberAction}
        className="flex max-w-2xl flex-col gap-6"
      >
        <MemberFields
          branches={branches}
          values={{ homeBranchId: ctx.activeBranchId ?? branches[0]?.id }}
        />
        <fieldset className="flex flex-col gap-3 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Messages</legend>
          <p className="text-sm text-muted">
            Service messages (receipts, renewal reminders) are sent to run the
            membership. Offers and news need the member&apos;s explicit yes;
            leave these unticked unless they agreed.
          </p>
          <CheckboxField
            name="marketingEmail"
            label="Offers and news by email"
          />
          <CheckboxField
            name="marketingWhatsapp"
            label="Offers and news on WhatsApp"
          />
        </fieldset>
        <CheckboxField
          name="confirmDuplicate"
          label="Create anyway if this mobile or email is already used"
          hint="Only for family members sharing a number. Otherwise open the existing member."
        />
        <div>
          <SubmitButton>Add member</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
