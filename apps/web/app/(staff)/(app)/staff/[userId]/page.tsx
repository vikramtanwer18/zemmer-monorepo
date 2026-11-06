import { listAuditLogs } from "@gym/core/audit";
import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getAvailability, getStaffProfile } from "@gym/core/staff";
import {
  ActionForm,
  Badge,
  Button,
  Card,
  CardTitle,
  CheckboxField,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day, when } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  addExceptionAction,
  removeCertificationAction,
  removeExceptionAction,
  saveTrainerAction,
  saveWeeklyAction,
  updateStaffProfileAction,
} from "./actions";
import { CertificateForm } from "./certificate-form";

export const metadata: Metadata = { title: "Staff member" };

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export default async function StaffMemberPage({
  params,
  searchParams,
}: PageProps<"/staff/[userId]">) {
  const { userId } = await params;
  const { ctx } = await requireReady(`/staff/${userId}`);
  const self = userId === ctx.userId;
  if (!hasPermission(ctx, "staff.view") && !self) return <NoAccess />;
  const { deps, db } = services();
  const profile = hasPermission(ctx, "staff.view")
    ? await getStaffProfile(deps, ctx, userId)
    : null;
  const availability = await getAvailability(deps, ctx, userId);
  const writable = isTenantWritable(ctx);
  const canManage = writable && !!profile?.canManage;
  const canEditHours = writable && (self || canManage);
  const activity = hasPermission(ctx, "audit.view")
    ? await listAuditLogs(db, ctx, { actorUserId: userId, pageSize: 15 })
    : null;
  const weekly = new Map(availability.weekly.map((w) => [w.dayOfWeek, w]));

  return (
    <>
      <PageHeader
        title={profile?.name ?? "My working hours"}
        description={
          profile
            ? `${profile.email} · ${profile.roles.map((r) => `${r.label} (${r.branch})`).join(", ")}`
            : undefined
        }
        actions={
          profile && (
            <a href="/staff" className="text-sm text-primary underline">
              All staff
            </a>
          )
        }
      />
      <Flash params={await searchParams} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {profile && (
          <Card className="flex flex-col gap-4">
            <CardTitle>Details</CardTitle>
            {profile.status !== "ACTIVE" && (
              <Badge tone="warning">Deactivated</Badge>
            )}
            {canManage ? (
              <ActionForm
                action={updateStaffProfileAction}
                className="flex flex-col gap-3"
              >
                <input type="hidden" name="userId" value={userId} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField
                    label="Job title"
                    name="jobTitle"
                    defaultValue={profile.profile?.jobTitle ?? ""}
                  />
                  <FormField
                    label="Phone"
                    name="phone"
                    type="tel"
                    defaultValue={profile.profile?.phone ?? ""}
                  />
                  <SelectField
                    label="Employment"
                    name="employmentType"
                    defaultValue={profile.profile?.employmentType ?? ""}
                    placeholder="Not set"
                    options={[
                      { value: "FULL_TIME", label: "Full time" },
                      { value: "PART_TIME", label: "Part time" },
                      { value: "CONTRACT", label: "Contract" },
                    ]}
                  />
                  <FormField
                    label="Started on"
                    name="startDate"
                    type="date"
                    defaultValue={profile.profile?.startDate ?? ""}
                  />
                  <FormField
                    label="Emergency contact"
                    name="emergencyName"
                    defaultValue={profile.profile?.emergencyName ?? ""}
                  />
                  <FormField
                    label="Emergency phone"
                    name="emergencyPhone"
                    type="tel"
                    defaultValue={profile.profile?.emergencyPhone ?? ""}
                  />
                </div>
                <div>
                  <SubmitButton variant="outline">Save details</SubmitButton>
                </div>
              </ActionForm>
            ) : (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted">Job title</dt>
                <dd>{profile.profile?.jobTitle ?? "—"}</dd>
                <dt className="text-muted">Phone</dt>
                <dd>{profile.profile?.phone ?? "—"}</dd>
                <dt className="text-muted">Started</dt>
                <dd>{day(profile.profile?.startDate)}</dd>
              </dl>
            )}
          </Card>
        )}

        {profile?.canSeePay && (
          <Card className="flex flex-col gap-4">
            <CardTitle>Pay</CardTitle>
            <p className="text-xs text-muted">
              Only people allowed to see pay details see this card. Changes are
              logged without the amounts.
            </p>
            <ActionForm
              action={updateStaffProfileAction}
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="userId" value={userId} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SelectField
                  label="Paid"
                  name="payBasis"
                  defaultValue={profile.pay?.payBasis ?? ""}
                  placeholder="Not set"
                  options={[
                    { value: "MONTHLY", label: "Monthly salary" },
                    { value: "HOURLY", label: "Per hour" },
                    { value: "PER_SESSION", label: "Per session" },
                  ]}
                />
                <FormField
                  label="Rate (₹)"
                  name="payRate"
                  inputMode="decimal"
                  defaultValue={profile.pay?.payRate ?? ""}
                />
              </div>
              <TextareaField
                label="Notes"
                name="payNotes"
                rows={2}
                defaultValue={profile.pay?.payNotes ?? ""}
              />
              {canManage && (
                <div>
                  <SubmitButton variant="outline">Save pay</SubmitButton>
                </div>
              )}
            </ActionForm>
          </Card>
        )}

        {profile && (canManage || profile.trainer) && (
          <Card className="flex flex-col gap-4">
            <CardTitle>Trainer profile</CardTitle>
            {!profile.trainer && (
              <p className="text-sm text-muted">
                Make this person a trainer so they can be put on classes, PT
                sessions and members.
              </p>
            )}
            {canManage ? (
              <ActionForm
                action={saveTrainerAction}
                className="flex flex-col gap-3"
              >
                <input type="hidden" name="userId" value={userId} />
                <FormField
                  label="Name shown to members"
                  name="displayName"
                  required
                  defaultValue={profile.trainer?.displayName ?? profile.name}
                />
                <FormField
                  label="Specialties"
                  name="specialties"
                  hint="Separate with commas, e.g. Strength, Yoga"
                  defaultValue={profile.trainer?.specialties.join(", ") ?? ""}
                />
                <TextareaField
                  label="Bio"
                  name="bio"
                  rows={3}
                  defaultValue={profile.trainer?.bio ?? ""}
                />
                <CheckboxField
                  name="visibleToMembers"
                  label="Show to members in the app"
                  defaultChecked={profile.trainer?.visibleToMembers ?? true}
                />
                <CheckboxField
                  name="active"
                  label="Active trainer"
                  defaultChecked={
                    profile.trainer ? profile.trainer.status === "ACTIVE" : true
                  }
                />
                <div>
                  <SubmitButton variant="outline">
                    {profile.trainer ? "Save trainer profile" : "Make trainer"}
                  </SubmitButton>
                </div>
              </ActionForm>
            ) : (
              profile.trainer && (
                <p className="text-sm">
                  {profile.trainer.displayName} ·{" "}
                  {profile.trainer.specialties.join(", ")}
                </p>
              )
            )}
            {profile.trainer && (
              <>
                <p className="text-sm text-muted">
                  {profile.trainer.activeClients} assigned client
                  {profile.trainer.activeClients === 1 ? "" : "s"}
                </p>
                <h3 className="text-sm font-semibold">Certifications</h3>
                {profile.trainer.certifications.length === 0 ? (
                  <p className="text-sm text-muted">None added.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border text-sm">
                    {profile.trainer.certifications.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between gap-2 py-2"
                      >
                        <span>
                          <span className="font-medium">{c.title}</span>
                          <span className="block text-xs text-muted">
                            {[
                              c.issuer,
                              c.issuedOn && `issued ${day(c.issuedOn)}`,
                              c.expiresOn && `expires ${day(c.expiresOn)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          {c.hasFile && (
                            <a
                              className="text-primary underline"
                              href={`/api/certifications/${c.id}`}
                            >
                              File
                            </a>
                          )}
                          {canManage && (
                            <form action={removeCertificationAction}>
                              <input
                                type="hidden"
                                name="userId"
                                value={userId}
                              />
                              <input type="hidden" name="id" value={c.id} />
                              <Button type="submit" size="sm" variant="ghost">
                                Remove
                              </Button>
                            </form>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && (
                  <CertificateForm trainerId={profile.trainer.id} />
                )}
              </>
            )}
          </Card>
        )}

        <Card className="flex flex-col gap-4">
          <CardTitle>Working hours</CardTitle>
          <p className="text-xs text-muted">
            Used to warn when a class or PT session is booked outside these
            hours. Leave everything unticked if you don&apos;t track hours.
          </p>
          {canEditHours ? (
            <ActionForm
              action={saveWeeklyAction}
              className="flex flex-col gap-2"
            >
              <input type="hidden" name="userId" value={userId} />
              {DAYS.map((name, i) => {
                const slot = weekly.get(i + 1);
                return (
                  <fieldset
                    key={name}
                    className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
                  >
                    <legend className="sr-only">{name}</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name={`day${i + 1}_on`}
                        defaultChecked={!!slot}
                        className="size-4"
                      />
                      {name.slice(0, 3)}
                    </label>
                    <input
                      type="time"
                      name={`day${i + 1}_from`}
                      aria-label={`${name} from`}
                      defaultValue={slot?.from ?? "06:00"}
                      className="h-9 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-sm"
                    />
                    <input
                      type="time"
                      name={`day${i + 1}_to`}
                      aria-label={`${name} until`}
                      defaultValue={
                        slot?.to === "24:00" ? "23:59" : (slot?.to ?? "14:00")
                      }
                      className="h-9 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-sm"
                    />
                  </fieldset>
                );
              })}
              <div>
                <SubmitButton variant="outline">Save hours</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <ul className="text-sm">
              {availability.weekly.length === 0 && (
                <li className="text-muted">Not set.</li>
              )}
              {availability.weekly.map((w) => (
                <li key={w.id}>
                  {DAYS[w.dayOfWeek - 1]}: {w.from}–{w.to}
                </li>
              ))}
            </ul>
          )}
          <h3 className="text-sm font-semibold">Leave and extra hours</h3>
          {availability.exceptions.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {availability.exceptions.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between py-2"
                >
                  <span>
                    {day(e.date)} ·{" "}
                    {e.available ? "Extra hours" : "Not available"}{" "}
                    {e.from === "00:00" && e.to === "24:00"
                      ? "(all day)"
                      : `${e.from}–${e.to}`}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                  {canEditHours && (
                    <form action={removeExceptionAction}>
                      <input type="hidden" name="userId" value={userId} />
                      <input type="hidden" name="id" value={e.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Remove
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEditHours && (
            <ActionForm
              action={addExceptionAction}
              resetOnSuccess
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              <input type="hidden" name="userId" value={userId} />
              <FormField label="Date" name="date" type="date" required />
              <SelectField
                label="Type"
                name="available"
                options={[
                  { value: "false", label: "Not available (leave)" },
                  { value: "true", label: "Extra hours" },
                ]}
              />
              <FormField label="From (optional)" name="from" type="time" />
              <FormField label="Until (optional)" name="to" type="time" />
              <FormField label="Note" name="note" />
              <div className="self-end">
                <SubmitButton variant="outline">Add</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>

        {activity && (
          <Card className="flex flex-col gap-3 lg:col-span-2">
            <CardTitle>Recent activity</CardTitle>
            {activity.rows.length === 0 ? (
              <p className="text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {activity.rows.map((r) => (
                  <li key={r.id} className="flex justify-between gap-2 py-2">
                    <span className="font-mono text-xs">{r.action}</span>
                    <span className="text-muted">
                      {when(r.createdAt, ctx.timezone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <a
              className="text-sm text-primary underline"
              href={`/audit-log?actorUserId=${userId}`}
            >
              Full activity log
            </a>
          </Card>
        )}
      </div>
    </>
  );
}
