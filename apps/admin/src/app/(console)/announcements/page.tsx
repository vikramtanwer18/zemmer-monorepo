import { listPlans } from "@gym/core/platform";
import { listAnnouncements } from "@gym/core/saas-billing";
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
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { at } from "@/lib/format";
import { Notices } from "@/lib/notices";
import { services } from "@/lib/services";
import { requireAdmin } from "@/lib/session";
import {
  archiveAnnouncementAction,
  createAnnouncementAction,
} from "../billing/actions";

export const metadata: Metadata = { title: "Announcements" };

const STATUSES = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "GRACE",
  "SUSPENDED",
  "CANCELLED",
] as const;

export default async function AnnouncementsPage({
  searchParams,
}: PageProps<"/announcements">) {
  const { ctx } = await requireAdmin("/announcements");
  if (!ctx.permissions.has("platform.announcements.manage"))
    return (
      <EmptyState
        title="No access"
        description="Only a Super Admin can post announcements."
      />
    );
  const sp = await searchParams;
  const rows = await listAnnouncements(services().db, ctx);
  const { plans } = await listPlans(services().deps, ctx);
  const codes = [...new Set(plans.map((p) => p.code))];
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Announcements"
        description="A banner at the top of the gym app for owners and staff: maintenance, new features, billing notices."
      />
      <Notices sp={sp} />
      <DataTable
        caption="Announcements"
        rows={rows}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No announcements yet" />}
        columns={[
          {
            key: "title",
            header: "Message",
            cell: (a) => (
              <span>
                <span className="font-medium">{a.title}</span>
                <span className="block text-sm text-muted">{a.body}</span>
              </span>
            ),
          },
          {
            key: "who",
            header: "For",
            hideOnMobile: true,
            cell: (a) =>
              a.audience === "ALL"
                ? "All gyms"
                : a.audience === "PLANS"
                  ? `Plans: ${a.planCodes.join(", ")}`
                  : `Status: ${a.statuses.map((s) => s.toLowerCase()).join(", ")}`,
          },
          {
            key: "when",
            header: "Shown",
            hideOnMobile: true,
            cell: (a) =>
              `${at(a.startsAt)} → ${a.endsAt ? at(a.endsAt) : "until taken down"}`,
          },
          {
            key: "state",
            header: "",
            cell: (a) =>
              a.archivedAt || (a.endsAt && a.endsAt <= now) ? (
                <Badge tone="neutral">ended</Badge>
              ) : a.startsAt > now ? (
                <Badge tone="info">scheduled</Badge>
              ) : (
                <span className="flex items-center gap-1">
                  <Badge tone="success">live</Badge>
                  <ConfirmDialog
                    trigger="Take down"
                    title="Take this announcement down?"
                    confirmLabel="Take down"
                    formAction={archiveAnnouncementAction}
                    fields={{ id: a.id }}
                  />
                </span>
              ),
          },
        ]}
      />
      <section aria-labelledby="new" className="mt-8 max-w-2xl">
        <h2 id="new" className="mb-3 text-base font-semibold">
          New announcement
        </h2>
        <ActionForm
          action={createAnnouncementAction}
          resetOnSuccess
          className="flex flex-col gap-3"
        >
          <FormField label="Title" name="title" required maxLength={120} />
          <TextareaField
            label="Message"
            name="body"
            rows={3}
            required
            maxLength={1000}
          />
          <SelectField
            label="Show to"
            name="audience"
            defaultValue="ALL"
            options={[
              { value: "ALL", label: "All gyms" },
              { value: "PLANS", label: "Gyms on these plans" },
              {
                value: "STATUSES",
                label: "Gyms with these subscription statuses",
              },
            ]}
          />
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-1 font-medium">
              Plans (when “these plans”)
            </legend>
            {codes.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="planCodes"
                  value={c}
                  className="size-4"
                />{" "}
                {c}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-1 font-medium">
              Statuses (when “these statuses”)
            </legend>
            {STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="statuses"
                  value={s}
                  className="size-4"
                />{" "}
                {s.toLowerCase()}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Starts (India time)"
              name="startsAt"
              type="datetime-local"
              hint="Empty = now"
            />
            <FormField
              label="Ends (India time, optional)"
              name="endsAt"
              type="datetime-local"
            />
          </div>
          <div>
            <SubmitButton>Publish</SubmitButton>
          </div>
        </ActionForm>
      </section>
    </>
  );
}
