import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { engagementOptions, listAnnouncements } from "@gym/core/engagement";
import { isFeatureEnabled } from "@gym/core/entitlements";
import { entitlementsFor } from "@gym/core/tenancy";
import {
  ActionForm,
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
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  archiveAnnouncementAction,
  publishAnnouncementAction,
} from "./actions";
import { EngagementTabs } from "./engagement-tabs";

export const metadata: Metadata = { title: "Announcements" };

export default async function AnnouncementsPage({
  searchParams,
}: PageProps<"/engagement">) {
  const { ctx } = await requireReady("/engagement");
  if (!hasPermission(ctx, "engagement.manage")) return <NoAccess />;
  const sp = await searchParams;
  const { deps } = services();
  const [rows, options, ent] = [
    await listAnnouncements(deps, ctx),
    await engagementOptions(deps, ctx),
    await entitlementsFor(deps, ctx.tenantId),
  ];
  const { branches, plans: planList } = options;
  return (
    <>
      <PageHeader
        title="Engagement"
        description="News for members: it shows in their app feed and as an in-app notification."
      />
      <EngagementTabs
        current="/engagement"
        rewards={isFeatureEnabled(ent, "rewards.enabled")}
      />
      <Flash params={sp} />
      {isTenantWritable(ctx) && (
        <section className="mb-8 max-w-2xl">
          <h2 className="mb-3 text-base font-semibold">New announcement</h2>
          <ActionForm
            action={publishAnnouncementAction}
            resetOnSuccess
            className="flex flex-col gap-3"
          >
            <FormField label="Title" name="title" required />
            <TextareaField label="Message" name="body" rows={3} required />
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="Who"
                name="audience"
                options={[
                  { value: "ALL", label: "All members" },
                  { value: "BRANCH", label: "One branch" },
                  { value: "PLAN", label: "Members on a plan" },
                ]}
              />
              <SelectField
                label="Branch (for one branch)"
                name="branchId"
                options={[
                  { value: "", label: "—" },
                  ...branches.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
              <SelectField
                label="Plan (for a plan)"
                name="planId"
                options={[
                  { value: "", label: "—" },
                  ...planList.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
            <FormField
              label="Hide after (optional)"
              name="expiresAt"
              type="date"
            />
            <div>
              <SubmitButton>Post</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
      <DataTable
        caption="Announcements"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<EmptyState title="Nothing posted yet" />}
        columns={[
          {
            key: "t",
            header: "Announcement",
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-medium">{r.title}</span>
                <span className="line-clamp-2 text-xs text-muted">
                  {r.body}
                </span>
              </span>
            ),
          },
          {
            key: "a",
            header: "For",
            cell: (r) =>
              r.audience === "ALL"
                ? "Everyone"
                : r.audience === "BRANCH"
                  ? (branches.find((b) => b.id === r.branchId)?.name ??
                    "Branch")
                  : (planList.find((p) => p.id === r.planId)?.name ?? "Plan"),
          },
          {
            key: "n",
            header: "Notified",
            hideOnMobile: true,
            cell: (r) => r.notified,
          },
          {
            key: "w",
            header: "Posted",
            hideOnMobile: true,
            cell: (r) => when(r.publishedAt, ctx.timezone),
          },
          {
            key: "x",
            header: "",
            cell: (r) =>
              isTenantWritable(ctx) ? (
                <ConfirmDialog
                  trigger="Take down"
                  title="Take this down?"
                  description="It disappears from members' feeds."
                  confirmLabel="Take down"
                  formAction={archiveAnnouncementAction}
                  fields={{ id: r.id }}
                />
              ) : null,
          },
        ]}
      />
    </>
  );
}
