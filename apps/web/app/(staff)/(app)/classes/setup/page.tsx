import {
  allowedBranchIds,
  hasPermission,
  isTenantWritable,
} from "@gym/core/authz";
import { listCategories, listRooms } from "@gym/core/classes";
import {
  ActionForm,
  Card,
  CardTitle,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { createCategoryAction, createRoomAction } from "../actions";
import { ClassesTabs } from "../classes-tabs";

export const metadata: Metadata = { title: "Rooms & categories" };

export default async function ClassSetupPage() {
  const { ctx, access } = await requireReady("/classes/setup");
  if (!hasPermission(ctx, "classes.view")) return <NoAccess />;
  const { deps } = services();
  const categories = await listCategories(deps, ctx);
  const rooms = await listRooms(deps, ctx);
  const canManage =
    isTenantWritable(ctx) && hasPermission(ctx, "classes.manage");
  const allowed = allowedBranchIds(ctx, "classes.manage");
  const branches = access.branches.filter(
    (b) => allowed === "ALL" || allowed.includes(b.id),
  );
  return (
    <>
      <PageHeader title="Rooms & categories" />
      <ClassesTabs current="/classes/setup" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          <CardTitle>Categories</CardTitle>
          {categories.length === 0 ? (
            <p className="text-sm text-muted">
              None yet. Categories colour the calendar (e.g. Yoga, Strength,
              Cardio).
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  {c.name}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <ActionForm
              action={createCategoryAction}
              resetOnSuccess
              className="flex flex-wrap items-end gap-3"
            >
              <FormField label="New category" name="name" required />
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Colour
                <input
                  type="color"
                  name="color"
                  defaultValue="#204289"
                  className="h-10 w-16 rounded-md border border-border bg-surface"
                />
              </label>
              <SubmitButton variant="outline">Add</SubmitButton>
            </ActionForm>
          )}
        </Card>
        <Card className="flex flex-col gap-4">
          <CardTitle>Rooms</CardTitle>
          {rooms.length === 0 ? (
            <p className="text-sm text-muted">
              None yet. Rooms let us warn you when two classes clash.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {rooms.map((r) => (
                <li key={r.id} className="flex justify-between py-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-muted">
                    {r.branch.name}
                    {r.capacity ? ` · holds ${r.capacity}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && branches.length > 0 && (
            <ActionForm
              action={createRoomAction}
              resetOnSuccess
              className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end"
            >
              <FormField label="Room name" name="name" required />
              <SelectField
                label="Branch"
                name="branchId"
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
              <FormField
                label="Holds (optional)"
                name="capacity"
                type="number"
                min={1}
              />
              <div>
                <SubmitButton variant="outline">Add room</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
