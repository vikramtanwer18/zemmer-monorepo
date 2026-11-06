import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listClassTemplates } from "@gym/core/classes";
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
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { archiveTemplateAction } from "../actions";
import { ClassesTabs } from "../classes-tabs";

export const metadata: Metadata = { title: "Recurring classes" };

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function TemplatesPage({
  searchParams,
}: PageProps<"/classes/templates">) {
  const { ctx } = await requireReady("/classes/templates");
  if (!hasPermission(ctx, "classes.view")) return <NoAccess />;
  const templates = await listClassTemplates(services().deps, ctx);
  const canManage =
    isTenantWritable(ctx) && hasPermission(ctx, "classes.manage");
  return (
    <>
      <PageHeader
        title="Recurring classes"
        description="Sessions are created 8 weeks ahead. Changing a class never moves sessions people have booked: those are marked for you to check."
        actions={
          canManage && (
            <LinkButton href="/classes/templates/new">
              New recurring class
            </LinkButton>
          )
        }
      />
      <ClassesTabs current="/classes/templates" />
      <Flash params={await searchParams} />
      <DataTable
        caption="Recurring classes"
        rows={templates}
        rowKey={(t) => t.id}
        empty={
          <EmptyState
            title="No recurring classes"
            description="For example: Yoga every Monday and Wednesday at 06:30."
            action={
              canManage ? (
                <LinkButton href="/classes/templates/new">
                  New recurring class
                </LinkButton>
              ) : undefined
            }
          />
        }
        columns={[
          {
            key: "name",
            header: "Class",
            cell: (t) =>
              canManage ? (
                <a
                  className="font-medium text-primary underline"
                  href={`/classes/templates/${t.id}`}
                >
                  {t.name}
                </a>
              ) : (
                <span className="font-medium">{t.name}</span>
              ),
          },
          {
            key: "when",
            header: "When",
            cell: (t) => (
              <span>
                {t.byDays.map((d) => DAY[d]).join(", ")} at {t.startTime}
                <span className="block text-xs text-muted">
                  from {t.startDate}
                  {t.untilDate ? ` until ${t.untilDate}` : ""}
                  {t.occurrenceCount ? `, ${t.occurrenceCount} classes` : ""}
                </span>
              </span>
            ),
          },
          {
            key: "branch",
            header: "Branch",
            hideOnMobile: true,
            cell: (t) => t.branch.name,
          },
          {
            key: "who",
            header: "Trainer / room",
            hideOnMobile: true,
            cell: (t) =>
              [t.trainer?.displayName, t.room?.name]
                .filter(Boolean)
                .join(" · ") || "—",
          },
          { key: "cap", header: "Places", cell: (t) => t.capacity },
          {
            key: "plans",
            header: "Plans",
            hideOnMobile: true,
            cell: (t) =>
              t.eligiblePlanCodes.length ? (
                <Badge tone="info">{t.eligiblePlanCodes.length} plan(s)</Badge>
              ) : (
                "Any with classes"
              ),
          },
          ...(canManage
            ? [
                {
                  key: "archive",
                  header: "",
                  cell: (t: (typeof templates)[number]) => (
                    <ConfirmDialog
                      trigger="Archive"
                      title={`Archive ${t.name}?`}
                      description="Future sessions without bookings are removed. Sessions with bookings stay until you cancel them."
                      confirmLabel="Archive"
                      formAction={archiveTemplateAction}
                      fields={{ templateId: t.id }}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
