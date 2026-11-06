import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import { getBranch } from "@gym/core/tenancy";
import { Badge, ConfirmDialog, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { Flash } from "@/components/flash";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveBranchAction, updateBranchAction } from "../../actions";
import { BranchForm } from "../branch-form";

export const metadata: Metadata = { title: "Branch" };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function BranchPage({
  params,
  searchParams,
}: PageProps<"/branches/[id]">) {
  const { id } = await params;
  const { ctx } = await requireReady(`/branches/${id}`);
  if (!UUID.test(id)) notFound();
  const branch = await getBranch(services().deps, ctx, id).catch((err) => {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    if (isAppError(err) && err.code === "FORBIDDEN") return null;
    throw err;
  });
  if (!branch) return <NoAccess />;
  const canManage =
    hasPermission(ctx, "branches.manage") && isTenantWritable(ctx);
  const archived = branch.status === "ARCHIVED";

  return (
    <>
      <PageHeader
        title={branch.name}
        description={
          <>
            Code {branch.code}{" "}
            {archived && <Badge tone="neutral">Archived</Badge>}
          </>
        }
        actions={
          canManage && (
            <ConfirmDialog
              trigger={archived ? "Restore branch" : "Archive branch"}
              title={
                archived ? `Restore ${branch.name}?` : `Archive ${branch.name}?`
              }
              description={
                archived
                  ? "It counts towards your plan's branch limit again."
                  : "Nothing is deleted. The branch disappears from pickers and stops counting towards your plan limit."
              }
              confirmLabel={archived ? "Restore" : "Archive"}
              confirmVariant={archived ? "primary" : "danger"}
              formAction={archiveBranchAction}
              fields={{ id: branch.id, archived: archived ? "false" : "true" }}
            />
          )
        }
      />
      <Flash params={await searchParams} />
      <BranchForm
        action={updateBranchAction}
        values={branch}
        submitLabel="Save branch"
        disabled={!canManage}
      />
    </>
  );
}
