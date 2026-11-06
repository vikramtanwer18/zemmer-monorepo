import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { isFeatureEnabled } from "@gym/core/entitlements";
import { listWorkoutTemplates } from "@gym/core/fitness";
import { entitlementsFor } from "@gym/core/tenancy";
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { orUpgrade, UpgradeNotice } from "@/components/upgrade-notice";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveTemplateAction } from "../actions";
import { FitnessTabs } from "../fitness-tabs";

export const metadata: Metadata = { title: "Workout templates" };

export default async function TemplatesPage({
  searchParams,
}: PageProps<"/fitness/templates">) {
  const { ctx } = await requireReady("/fitness/templates");
  if (!hasPermission(ctx, "fitness.manage")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const rows = await orUpgrade(listWorkoutTemplates(deps, ctx));
  if (!rows)
    return (
      <UpgradeNotice title="Workout templates" feature="Workout programs" />
    );
  const ent = await entitlementsFor(deps, ctx.tenantId);
  const canEdit = isTenantWritable(ctx);
  return (
    <>
      <PageHeader
        title="Fitness"
        description="Reusable programs. Assigning one gives the member their own copy you can then adjust."
        actions={
          canEdit ? (
            <LinkButton href="/fitness/templates/edit">New template</LinkButton>
          ) : null
        }
      />
      <FitnessTabs
        current="/fitness/templates"
        nutrition={isFeatureEnabled(ent, "nutrition.enabled")}
      />
      <Flash params={sp} />
      <DataTable
        caption="Workout templates"
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="No templates yet"
            description="Build one: weeks, days and exercises."
          />
        }
        columns={[
          {
            key: "name",
            header: "Template",
            cell: (r) => (
              <a
                className="font-medium text-primary underline"
                href={`/fitness/templates/edit?id=${r.id}`}
              >
                {r.name}
              </a>
            ),
          },
          {
            key: "level",
            header: "Level",
            cell: (r) => <Badge>{r.level.toLowerCase()}</Badge>,
          },
          {
            key: "shape",
            header: "Shape",
            cell: (r) => `${r.weeks} wk · up to ${r.daysPerWeek} days`,
          },
          {
            key: "assigned",
            header: "Assigned",
            hideOnMobile: true,
            cell: (r) => r.assigned,
          },
          {
            key: "x",
            header: "",
            cell: (r) =>
              canEdit ? (
                <ConfirmDialog
                  trigger="Archive"
                  title={`Archive ${r.name}?`}
                  description="Members keep their own copies."
                  confirmLabel="Archive"
                  formAction={archiveTemplateAction}
                  fields={{ templateId: r.id }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
