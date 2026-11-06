import { Badge, Button, ConfirmDialog, EmptyState } from "@gym/ui";
import { cancelAppointmentAction, markAppointmentAction } from "./actions";

export type AppointmentRow = {
  id: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: Date;
  member: { id: string; name: string; memberCode: string };
  trainer: { displayName: string };
  branch: string;
  package: string;
  notes: string | null;
};

const TONE: Record<string, "info" | "success" | "danger" | "neutral"> = {
  SCHEDULED: "info",
  COMPLETED: "success",
  NO_SHOW: "danger",
  CANCELLED: "neutral",
};

const hasStarted = (d: Date) => d.getTime() <= Date.now();

/** PT sessions with complete / no-show / cancel controls (permissions re-checked on submit). */
export function AppointmentList({
  rows,
  back,
  canAct,
  showTrainer = true,
  linkMembers = false,
}: {
  rows: AppointmentRow[];
  back: string;
  canAct: boolean;
  showTrainer?: boolean;
  linkMembers?: boolean;
}) {
  if (rows.length === 0)
    return (
      <EmptyState
        title="No PT sessions"
        description="Book one from the member's page."
      />
    );
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
      {rows.map((a) => {
        const started = hasStarted(a.startsAt);
        return (
          <li
            key={a.id}
            className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="font-medium">
                {a.date} {a.startTime}–{a.endTime} ·{" "}
                {linkMembers ? (
                  <a
                    className="text-primary underline"
                    href={`/members/${a.member.id}`}
                  >
                    {a.member.name}
                  </a>
                ) : (
                  a.member.name
                )}
              </p>
              <p className="text-xs text-muted">
                {a.package}
                {showTrainer ? ` · ${a.trainer.displayName}` : ""} · {a.branch}
                {a.notes ? ` · ${a.notes}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[a.status] ?? "neutral"}>
                {a.status.replace("_", " ").toLowerCase()}
              </Badge>
              {canAct && a.status === "SCHEDULED" && started && (
                <>
                  <form action={markAppointmentAction}>
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="status" value="COMPLETED" />
                    <input type="hidden" name="back" value={back} />
                    <Button type="submit" size="sm">
                      Completed
                    </Button>
                  </form>
                  <form action={markAppointmentAction}>
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <input type="hidden" name="status" value="NO_SHOW" />
                    <input type="hidden" name="back" value={back} />
                    <Button type="submit" size="sm" variant="ghost">
                      No-show
                    </Button>
                  </form>
                </>
              )}
              {canAct && a.status === "SCHEDULED" && !started && (
                <ConfirmDialog
                  trigger="Cancel"
                  title="Cancel this PT session?"
                  description="Inside the gym's cutoff it counts as a no-show. The member is told."
                  confirmLabel="Cancel session"
                  formAction={cancelAppointmentAction}
                  fields={{ appointmentId: a.id, back }}
                >
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Reason
                    <input
                      name="reason"
                      required
                      minLength={2}
                      className="h-10 rounded-md border border-border bg-surface px-3"
                    />
                  </label>
                </ConfirmDialog>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
