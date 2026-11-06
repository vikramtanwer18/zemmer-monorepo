import { getFloorSettings, listScanDevices } from "@gym/core/attendance";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import {
  ActionForm,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { SettingsTabs } from "../settings-tabs";
import {
  archiveDeviceAction,
  createDeviceAction,
  updateFloorSettingsAction,
} from "./actions";

export const metadata: Metadata = { title: "Check-in & classes settings" };

export default async function FloorSettingsPage({
  searchParams,
}: PageProps<"/settings/floor">) {
  const { ctx } = await requireReady("/settings/floor");
  if (!hasPermission(ctx, "settings.view")) return <NoAccess />;
  const { deps } = services();
  const s = await getFloorSettings(deps, ctx);
  const devices = hasPermission(ctx, "attendance.scan")
    ? await listScanDevices(deps, ctx)
    : [];
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "settings.manage");
  const canDevices =
    isTenantWritable(ctx) && hasPermission(ctx, "staff.manage");
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings/floor" />
      <Flash params={await searchParams} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <ActionForm
          action={updateFloorSettingsAction}
          className="flex flex-col gap-6"
        >
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">Check-in</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Refuse a second check-in within (minutes)"
                name="checkinDuplicateMinutes"
                type="number"
                min={0}
                defaultValue={s.checkinDuplicateMinutes}
                hint="0 turns this off."
              />
              <SelectField
                label="When a member owes money"
                name="duesAtCheckin"
                defaultValue={s.duesAtCheckin}
                options={[
                  { value: "WARN", label: "Let them in, show a warning" },
                  { value: "BLOCK", label: "Refuse until they pay" },
                ]}
              />
            </div>
            <div
              role="group"
              aria-labelledby="checkout-label"
              className="flex flex-col gap-2"
            >
              <span id="checkout-label" className="text-sm font-medium">
                Members also check out at
              </span>
              {s.branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="checkoutBranchIds"
                    value={b.id}
                    defaultChecked={b.checkoutEnabled}
                    className="size-4"
                  />
                  {b.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">Classes</legend>
            <CheckboxField
              name="autoMarkClassAttendance"
              label="A check-in marks the member's booked classes (starting within 2 hours) as attended"
              defaultChecked={s.autoMarkClassAttendance}
            />
            <CheckboxField
              name="lateCancelForfeitsCredit"
              label="Late cancellations (after the class's cutoff) keep the class credit used"
              defaultChecked={s.lateCancelForfeitsCredit}
            />
            <FormField
              label="Remind members before class (hours)"
              name="bookingReminderHours"
              type="number"
              min={0}
              defaultValue={s.bookingReminderHours}
              hint="0 turns reminders off."
            />
          </fieldset>
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">
              Personal training
            </legend>
            <CheckboxField
              name="ptNoShowConsumesSession"
              label="A no-show uses up a session"
              defaultChecked={s.ptNoShowConsumesSession}
            />
            <FormField
              label="Cancellations closer than this count as a no-show (hours)"
              name="ptCancelCutoffHours"
              type="number"
              min={0}
              defaultValue={s.ptCancelCutoffHours}
            />
          </fieldset>
          {canEdit && (
            <div>
              <SubmitButton>Save</SubmitButton>
            </div>
          )}
        </ActionForm>
        <Card className="flex flex-col gap-3 self-start">
          <CardTitle>Named scanners</CardTitle>
          <p className="text-sm text-muted">
            Optional. Name each reception tablet or phone so check-ins show
            which device scanned them.
          </p>
          {devices.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between py-2"
                >
                  <span>
                    {d.name}{" "}
                    <span className="text-muted">· {d.branch.name}</span>
                  </span>
                  {canDevices && (
                    <form action={archiveDeviceAction}>
                      <input type="hidden" name="deviceId" value={d.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Remove
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canDevices && (
            <ActionForm
              action={createDeviceAction}
              resetOnSuccess
              className="flex flex-col gap-3"
            >
              <FormField
                label="Name"
                name="name"
                placeholder="Front desk tablet"
                required
              />
              <SelectField
                label="Branch"
                name="branchId"
                options={s.branches.map((b) => ({
                  value: b.id,
                  label: b.name,
                }))}
              />
              <div>
                <SubmitButton variant="outline">Add scanner</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
