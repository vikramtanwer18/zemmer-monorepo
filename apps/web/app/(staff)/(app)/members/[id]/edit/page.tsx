import { hasPermission } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import { getMemberProfile, memberName } from "@gym/core/members";
import { fromDbDate } from "@gym/core/time/dates";
import { ActionForm, Breadcrumbs, PageHeader, SubmitButton } from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { updateMemberAction } from "../../actions";
import { MemberFields } from "../../member-fields";

export const metadata: Metadata = { title: "Edit member" };

export default async function EditMemberPage({
  params,
}: PageProps<"/members/[id]/edit">) {
  const { id } = await params;
  const { ctx, access } = await requireReady(`/members/${id}/edit`);
  const profile = await getMemberProfile(services().deps, ctx, id).catch(
    (err) => {
      if (isAppError(err) && err.code === "NOT_FOUND") notFound();
      return null;
    },
  );
  if (
    !profile ||
    !hasPermission(ctx, "members.edit", {
      branchId: profile.member.homeBranchId,
    })
  )
    return <NoAccess />;
  const m = profile.member;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Members", href: "/members" },
          { label: memberName(m), href: `/members/${id}` },
          { label: "Edit" },
        ]}
      />
      <PageHeader title={`Edit ${memberName(m)}`} />
      <ActionForm
        action={updateMemberAction}
        className="flex max-w-2xl flex-col gap-6"
      >
        <input type="hidden" name="memberId" value={id} />
        <MemberFields
          branches={access.branches.filter((b) =>
            hasPermission(ctx, "members.edit", { branchId: b.id }),
          )}
          values={{
            ...m,
            dateOfBirth: m.dateOfBirth ? fromDbDate(m.dateOfBirth) : null,
          }}
        />
        <div>
          <SubmitButton>Save member</SubmitButton>
        </div>
      </ActionForm>
    </>
  );
}
