import { hasPermission } from "@gym/core/authz";
import { PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { requireReady } from "@/lib/session";
import { createBranchAction } from "../../actions";
import { BranchForm } from "../branch-form";

export const metadata: Metadata = { title: "Add branch" };

export default async function NewBranchPage() {
  const { ctx } = await requireReady("/branches/new");
  if (!hasPermission(ctx, "branches.manage")) return <NoAccess />;
  return (
    <>
      <PageHeader
        title="Add a branch"
        description="Your plan's branch limit applies."
      />
      <BranchForm action={createBranchAction} submitLabel="Create branch" />
    </>
  );
}
