import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { listMyClients, listPtAppointments, trainerDay } from "@gym/core/staff";
import {
  ActionForm,
  Badge,
  Card,
  CardTitle,
  EmptyState,
  FormField,
  PageHeader,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { day } from "@/lib/format";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import { bookAppointmentAction } from "../pt/actions";
import { AppointmentList } from "../pt/appointment-list";

export const metadata: Metadata = { title: "My day" };

/** Trainer view: my schedule today, my sessions, my clients (no payments, spec §6). */
export default async function MyDayPage({
  searchParams,
}: PageProps<"/my-day">) {
  const { ctx, user } = await requireReady("/my-day");
  if (!hasPermission(ctx, "clients.view") && !hasPermission(ctx, "pt.own"))
    return <NoAccess />;
  const { deps } = services();
  const today = await trainerDay(deps, ctx);
  if (!today)
    return (
      <>
        <PageHeader title="My day" />
        <EmptyState
          title="You don't have a trainer profile yet"
          description="Ask your manager to set one up on the Staff page."
        />
      </>
    );
  const pt = hasPermission(ctx, "pt.own")
    ? await listPtAppointments(deps, ctx, { mine: true, days: 1 })
    : { appointments: [] };
  const { clients } = await listMyClients(deps, ctx);
  return (
    <>
      <PageHeader
        title={`Hi, ${today.trainer.displayName}`}
        description={`${day(today.today)} · ${today.classes.length} class${today.classes.length === 1 ? "" : "es"}, ${today.pt.length} PT session${today.pt.length === 1 ? "" : "s"}`}
        actions={
          <a
            className="text-sm text-primary underline"
            href={`/staff/${user.id}`}
          >
            My working hours
          </a>
        }
      />
      <Flash params={await searchParams} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <CardTitle>My classes today</CardTitle>
          {today.classes.length === 0 ? (
            <p className="text-sm text-muted">No classes today.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {today.classes.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-2"
                >
                  <a
                    className="font-medium text-primary underline"
                    href={`/classes/${c.id}`}
                  >
                    {c.startTime} {c.name}
                  </a>
                  <span className="text-muted">
                    {c.booked}/{c.capacity}
                    {c.room ? ` · ${c.room}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <section aria-labelledby="pt-today" className="flex flex-col gap-3">
          <h2 id="pt-today" className="text-base font-semibold">
            My PT sessions today
          </h2>
          <AppointmentList
            rows={pt.appointments}
            back="/my-day"
            canAct={isTenantWritable(ctx)}
            showTrainer={false}
          />
        </section>
        {hasPermission(ctx, "pt.own") &&
          isTenantWritable(ctx) &&
          clients.some((c) => c.pt.some((p) => p.left > 0)) && (
            <Card className="flex flex-col gap-3 lg:col-span-2">
              <CardTitle>Book a PT session</CardTitle>
              <ActionForm
                action={bookAppointmentAction}
                className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end"
              >
                <input
                  type="hidden"
                  name="trainerId"
                  value={today.trainer.id}
                />
                <input type="hidden" name="back" value="/my-day" />
                <SelectField
                  label="Client and package"
                  name="balanceId"
                  options={clients.flatMap((c) =>
                    c.pt
                      .filter((p) => p.left > 0)
                      .map((p) => ({
                        value: p.id,
                        label: `${c.name}: ${p.name} (${p.left} left)`,
                      })),
                  )}
                />
                <FormField
                  label="Date"
                  name="date"
                  type="date"
                  required
                  defaultValue={today.today}
                />
                <FormField label="Time" name="time" type="time" required />
                <div>
                  <SubmitButton>Book</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}
        <Card className="flex flex-col gap-3 lg:col-span-2">
          <CardTitle>My clients ({clients.length})</CardTitle>
          {clients.length === 0 ? (
            <p className="text-sm text-muted">
              No members are assigned to you yet.
            </p>
          ) : (
            <ul
              className="grid grid-cols-1 gap-3 md:grid-cols-2"
              data-testid="my-clients"
            >
              {clients.map((c) => (
                <li
                  key={c.memberId}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <p className="font-medium">
                    {c.name}{" "}
                    <span className="text-muted">({c.memberCode})</span>
                  </p>
                  <p className="text-muted">{c.phone ?? "No phone"}</p>
                  {c.membership ? (
                    <p>
                      {c.membership.plan} ·{" "}
                      <Badge
                        tone={
                          c.membership.status === "ACTIVE"
                            ? "success"
                            : "warning"
                        }
                      >
                        {c.membership.status === "ACTIVE" ? "Active" : "Frozen"}
                      </Badge>{" "}
                      · {c.membership.daysLeft} days left
                    </p>
                  ) : (
                    <p className="text-warning">No current membership</p>
                  )}
                  {c.pt.map((p) => (
                    <p key={p.id} className="text-xs text-muted">
                      {p.name}: {p.left} session{p.left === 1 ? "" : "s"} left
                      {p.expiresOn ? `, use by ${day(p.expiresOn)}` : ""}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
