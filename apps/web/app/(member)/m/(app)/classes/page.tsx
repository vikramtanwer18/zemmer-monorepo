import { listMyBookings, listMyClasses } from "@gym/core/classes";
import { isAppError } from "@gym/core/errors";
import { addDays, todayIn } from "@gym/core/time/dates";
import { Alert, Badge, Button, Card, EmptyState } from "@gym/ui";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { str } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";
import {
  bookClassAction,
  cancelBookingAction,
  joinWaitlistAction,
  leaveWaitlistAction,
} from "./actions";

export const metadata: Metadata = { title: "Classes" };

function dayLabel(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default async function MemberClassesPage({
  searchParams,
}: PageProps<"/m/classes">) {
  const { mctx } = await requireMember("/m/classes");
  const sp = await searchParams;
  const today = todayIn(mctx.timezone);
  const requested = str(sp.day);
  const day =
    requested && requested >= today && requested <= addDays(today, 13)
      ? requested
      : today;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  let sessions: Awaited<ReturnType<typeof listMyClasses>> = [];
  let unavailable: string | null = null;
  try {
    sessions = await listMyClasses(services().deps, mctx, {
      from: day,
      days: 1,
    });
  } catch (err) {
    if (isAppError(err) && err.code === "ENTITLEMENT_REQUIRED")
      unavailable = err.message;
    else throw err;
  }
  const bookings = unavailable
    ? []
    : (await listMyBookings(services().deps, mctx)).filter(
        (b) => b.upcoming && b.status === "BOOKED",
      );

  return (
    <>
      <h1 className="text-xl font-semibold">Classes</h1>
      <Flash params={sp} />
      {unavailable ? (
        <Alert tone="info">{unavailable}</Alert>
      ) : (
        <>
          {bookings.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold">
                Your upcoming classes
              </h2>
              <ul className="flex flex-col gap-1 text-sm">
                {bookings.map((b) => (
                  <li key={b.id}>
                    {b.class} · {dayLabel(b.date, today)} {b.startTime}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <nav aria-label="Pick a day" className="-mx-4 overflow-x-auto px-4">
            <ul className="flex gap-2">
              {days.map((d) => (
                <li key={d}>
                  <a
                    href={`/m/classes?day=${d}`}
                    aria-current={d === day ? "page" : undefined}
                    className={`block whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${
                      d === day
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-surface"
                    }`}
                  >
                    {dayLabel(d, today)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {sessions.length === 0 ? (
            <EmptyState
              title="No classes this day"
              description="Pick another day above."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Card
                    className="flex flex-col gap-2 p-4"
                    data-testid="class-card"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{s.name}</p>
                        <p className="text-sm text-muted">
                          {s.startTime}–{s.endTime} · {s.branch}
                          {s.trainer ? ` · ${s.trainer}` : ""}
                        </p>
                      </div>
                      {s.status === "CANCELLED" ? (
                        <Badge tone="danger">Cancelled</Badge>
                      ) : s.booking ? (
                        <Badge tone="success">Booked</Badge>
                      ) : s.waitlist ? (
                        <Badge tone="info">
                          Waitlist #{s.waitlist.position}
                        </Badge>
                      ) : s.spotsLeft === 0 ? (
                        <Badge tone="warning">Full</Badge>
                      ) : (
                        <Badge>{s.spotsLeft} left</Badge>
                      )}
                    </div>
                    {s.status === "SCHEDULED" && (
                      <div className="flex flex-wrap items-center gap-2">
                        {s.booking ? (
                          <form action={cancelBookingAction}>
                            <input
                              type="hidden"
                              name="bookingId"
                              value={s.booking.id}
                            />
                            <input type="hidden" name="day" value={day} />
                            <Button type="submit" variant="outline" size="sm">
                              Cancel booking
                            </Button>
                          </form>
                        ) : s.waitlist ? (
                          <form action={leaveWaitlistAction}>
                            <input
                              type="hidden"
                              name="entryId"
                              value={s.waitlist.id}
                            />
                            <input type="hidden" name="day" value={day} />
                            <Button type="submit" variant="outline" size="sm">
                              Leave waitlist
                            </Button>
                          </form>
                        ) : s.window === "NOT_OPEN" ? (
                          <p className="text-xs text-muted">
                            Booking opens{" "}
                            {s.opensAt.toLocaleString("en-IN", {
                              timeZone: mctx.timezone,
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </p>
                        ) : s.window === "CLOSED" ? (
                          <p className="text-xs text-muted">Booking closed</p>
                        ) : s.spotsLeft > 0 ? (
                          <form action={bookClassAction}>
                            <input
                              type="hidden"
                              name="sessionId"
                              value={s.id}
                            />
                            <input type="hidden" name="day" value={day} />
                            <Button type="submit" size="sm">
                              Book
                            </Button>
                          </form>
                        ) : s.waitlistEnabled ? (
                          <form action={joinWaitlistAction}>
                            <input
                              type="hidden"
                              name="sessionId"
                              value={s.id}
                            />
                            <input type="hidden" name="day" value={day} />
                            <Button type="submit" size="sm" variant="secondary">
                              Join waitlist
                            </Button>
                          </form>
                        ) : null}
                        {(s.booking || s.waitlist) && (
                          <p className="text-xs text-muted">
                            Free cancellation until{" "}
                            {s.cancelCutoffAt.toLocaleString("en-IN", {
                              timeZone: mctx.timezone,
                              timeStyle: "short",
                            })}
                          </p>
                        )}
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
