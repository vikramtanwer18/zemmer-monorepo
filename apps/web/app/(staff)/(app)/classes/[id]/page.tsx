import { hasPermission, isTenantWritable } from "@gym/core/authz";
import { getClassSession } from "@gym/core/classes";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
} from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { NoAccess } from "@/components/no-access";
import { services } from "@/lib/services";
import { requireReady } from "@/lib/session";
import {
  cancelSessionAction,
  markAttendanceAction,
  removeWaitlistAction,
  staffCancelBookingAction,
  updateSessionAction,
} from "../actions";
import { classFormOptions } from "../options";
import { BookMember } from "./book-member";
import { EditSession } from "./edit-session";

export const metadata: Metadata = { title: "Class" };

const STATUS: Record<
  string,
  { label: string; tone: "success" | "danger" | "warning" | "neutral" | "info" }
> = {
  BOOKED: { label: "Booked", tone: "info" },
  ATTENDED: { label: "Attended", tone: "success" },
  NO_SHOW: { label: "No-show", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/** Wall-clock checks for the page (kept out of the component body). */
function timing(startsAt: Date) {
  const now = Date.now();
  return {
    started: startsAt.getTime() <= now,
    canMarkNow: startsAt.getTime() - 30 * 60_000 <= now,
  };
}

export default async function SessionPage({
  params,
  searchParams,
}: PageProps<"/classes/[id]">) {
  const { id } = await params;
  const { ctx, access } = await requireReady(`/classes/${id}`);
  if (!hasPermission(ctx, "classes.view")) return <NoAccess />;
  const s = await getClassSession(services().deps, ctx, id);
  const writable = isTenantWritable(ctx);
  const scheduled = s.status === "SCHEDULED";
  const { started, canMarkNow } = timing(s.startsAt);
  const live = s.bookings.filter((b) => b.status !== "CANCELLED");
  const waiting = s.waitlist.filter((w) => w.status === "WAITING");
  const full = s.bookedCount >= s.capacity;
  const options =
    writable && s.canManage && scheduled
      ? await classFormOptions(ctx, access)
      : null;

  return (
    <>
      <PageHeader
        title={s.name}
        description={`${s.date} · ${s.startTime}–${s.endTime} · ${s.branch}${s.trainer ? ` · ${s.trainer.name}` : ""}${s.room ? ` · ${s.room.name}` : ""}`}
        actions={
          <a
            href={`/classes?from=${s.date}`}
            className="text-sm text-primary underline"
          >
            Back to schedule
          </a>
        }
      />
      <Flash params={await searchParams} />
      {s.status === "CANCELLED" && (
        <Alert tone="danger" title="Cancelled" className="mb-4">
          {s.cancelReason}
        </Alert>
      )}
      {s.conflictNote && scheduled && (
        <Alert tone="warning" title="Please check" className="mb-4">
          {s.conflictNote}
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-sm text-muted">Booked</p>
          <p className="text-2xl font-semibold" data-testid="booked-count">
            {s.bookedCount}/{s.capacity}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted">Waiting</p>
          <p className="text-2xl font-semibold">{waiting.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted">Free cancellation until</p>
          <p className="font-semibold">
            {s.cancelCutoffAt.toLocaleTimeString("en-IN", {
              timeZone: ctx.timezone,
              timeStyle: "short",
            })}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted">Plans</p>
          <p className="font-semibold">
            {s.eligiblePlanCodes.length
              ? s.eligiblePlanCodes.join(", ")
              : "Any with classes"}
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <section aria-labelledby="roster">
            <h2 id="roster" className="mb-2 text-base font-semibold">
              Roster
            </h2>
            <DataTable
              caption="Roster"
              rows={live}
              rowKey={(b) => b.id}
              empty={<EmptyState title="Nobody booked yet" />}
              columns={[
                {
                  key: "member",
                  header: "Member",
                  cell: (b) => (
                    <span>
                      <span className="font-medium">{b.member.name}</span>
                      <span className="block text-xs text-muted">
                        {b.member.memberCode}
                        {b.source === "WAITLIST" ? " · from waitlist" : ""}
                        {b.usedCredit ? " · 1 credit" : ""}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  cell: (b) => (
                    <Badge tone={STATUS[b.status]?.tone ?? "neutral"}>
                      {STATUS[b.status]?.label ?? b.status}
                    </Badge>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  cell: (b) => (
                    <div className="flex flex-wrap gap-1">
                      {writable &&
                        s.canMark &&
                        canMarkNow &&
                        s.status !== "CANCELLED" && (
                          <>
                            {b.status !== "ATTENDED" && (
                              <form action={markAttendanceAction}>
                                <input
                                  type="hidden"
                                  name="sessionId"
                                  value={s.id}
                                />
                                <input
                                  type="hidden"
                                  name="bookingId"
                                  value={b.id}
                                />
                                <input
                                  type="hidden"
                                  name="status"
                                  value="ATTENDED"
                                />
                                <Button
                                  type="submit"
                                  size="sm"
                                  variant="outline"
                                >
                                  Attended
                                </Button>
                              </form>
                            )}
                            {b.status !== "NO_SHOW" && (
                              <form action={markAttendanceAction}>
                                <input
                                  type="hidden"
                                  name="sessionId"
                                  value={s.id}
                                />
                                <input
                                  type="hidden"
                                  name="bookingId"
                                  value={b.id}
                                />
                                <input
                                  type="hidden"
                                  name="status"
                                  value="NO_SHOW"
                                />
                                <Button type="submit" size="sm" variant="ghost">
                                  No-show
                                </Button>
                              </form>
                            )}
                          </>
                        )}
                      {writable &&
                        s.canBook &&
                        scheduled &&
                        !started &&
                        b.status === "BOOKED" && (
                          <ConfirmDialog
                            trigger="Cancel"
                            title={`Cancel ${b.member.name}'s booking?`}
                            description="After the cutoff it counts as a late cancellation. The next person on the waitlist moves up."
                            confirmLabel="Cancel booking"
                            formAction={staffCancelBookingAction}
                            fields={{
                              sessionId: s.id,
                              bookingId: b.id,
                              reason: "Cancelled by staff",
                            }}
                          />
                        )}
                    </div>
                  ),
                },
              ]}
            />
          </section>
          {s.waitlist.length > 0 && (
            <section aria-labelledby="waitlist">
              <h2 id="waitlist" className="mb-2 text-base font-semibold">
                Waitlist
              </h2>
              <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                {s.waitlist.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
                  >
                    <span>
                      #{w.position} {w.member.name}{" "}
                      <span className="text-muted">
                        ({w.member.memberCode})
                      </span>
                      {w.note && (
                        <span className="block text-xs text-muted">
                          {w.note}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge>{w.status.toLowerCase()}</Badge>
                      {writable && s.canBook && w.status === "WAITING" && (
                        <form action={removeWaitlistAction}>
                          <input type="hidden" name="sessionId" value={s.id} />
                          <input type="hidden" name="entryId" value={w.id} />
                          <Button type="submit" size="sm" variant="ghost">
                            Remove
                          </Button>
                        </form>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {writable && s.canBook && scheduled && !started && (
            <Card className="flex flex-col gap-3">
              <CardTitle>Book</CardTitle>
              <BookMember
                sessionId={s.id}
                full={full}
                waitlist={s.waitlistEnabled}
              />
            </Card>
          )}
          {options && (
            <Card className="flex flex-col gap-3">
              <CardTitle>Change this class</CardTitle>
              <EditSession
                action={updateSessionAction}
                sessionId={s.id}
                options={options}
                values={{
                  trainerId: s.trainer?.id ?? "",
                  roomId: s.room?.id ?? "",
                  capacity: s.capacity,
                }}
              />
              <ConfirmDialog
                trigger="Cancel this class"
                triggerVariant="danger"
                title={`Cancel ${s.name} on ${s.date}?`}
                description="Everyone booked is told by app notification and email, and any class credit is returned."
                confirmLabel="Cancel class"
                formAction={cancelSessionAction}
                fields={{ sessionId: s.id }}
              >
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Reason (members see it)
                  <input
                    name="reason"
                    required
                    minLength={3}
                    className="h-10 rounded-md border border-border bg-surface px-3"
                  />
                </label>
              </ConfirmDialog>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
