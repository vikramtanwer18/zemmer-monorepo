import { hasPermission } from "@gym/core/authz";
import { pipelineBoard } from "@gym/core/crm";
import { LinkButton, PageHeader } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { str } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { LeadsTabs } from "../leads-tabs";
import { Board } from "./board";

export const metadata: Metadata = { title: "Pipeline" };

export default async function BoardPage({
  searchParams,
}: PageProps<"/leads/board">) {
  const { ctx, access } = await requireReady("/leads/board");
  if (!hasPermission(ctx, "leads.view")) return <NoAccess />;
  const sp = await searchParams;
  const owner = str(sp.owner);
  const branchId = str(sp.branchId);
  const columns = await orUpgrade(
    pipelineBoard(services().deps, ctx, {
      ...(owner ? { owner } : {}),
      ...(branchId ? { branchId } : {}),
    }),
  );
  if (!columns)
    return <UpgradeNotice title="Pipeline" feature="Leads and CRM" />;
  const select = "h-9 rounded-md border border-border bg-surface px-2 text-sm";
  return (
    <>
      <PageHeader
        title="Leads"
        description="Open leads by stage. Won and lost show the last 30 days."
        actions={
          hasPermission(ctx, "leads.manage") ? (
            <LinkButton href="/leads/new">Add lead</LinkButton>
          ) : undefined
        }
      />
      <LeadsTabs current="/leads/board" />
      <Flash params={sp} />
      <form
        method="get"
        className="mb-3 flex flex-wrap items-end gap-2 text-sm"
      >
        <label className="flex items-center gap-2">
          Owner
          <select name="owner" defaultValue={owner ?? ""} className={select}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Nobody yet</option>
          </select>
        </label>
        {access.branches.length > 1 && (
          <label className="flex items-center gap-2">
            Branch
            <select
              name="branchId"
              defaultValue={branchId ?? ""}
              className={select}
            >
              <option value="">All</option>
              {access.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          className="h-9 rounded-md border border-border px-3"
        >
          Show
        </button>
      </form>
      <Board
        columns={columns.map((c) => ({
          ...c,
          leads: c.leads.map((l) => ({
            ...l,
            nextDue: l.nextDue ? l.nextDue.toISOString() : null,
          })),
        }))}
        canMove={hasPermission(ctx, "leads.manage")}
      />
    </>
  );
}
