import { getPassStatus, memberAttendance } from "@gym/core/attendance";
import {
  hasPermission,
  isTenantWritable,
  type AuthContext,
} from "@gym/core/authz";
import { isAppError } from "@gym/core/errors";
import {
  listPtPackages,
  listTrainers,
  memberPtBalances,
  memberTrainers,
} from "@gym/core/staff";
import { todayIn } from "@gym/core/time/dates";
import {
  ActionForm,
  Alert,
  Badge,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  FormField,
  SelectField,
  SubmitButton,
} from "@gym/ui";
import { CalendarCheck } from "lucide-react";
import { day, inr, when } from "@/lib/format";
import { services } from "@/lib/services";
import { bookAppointmentAction, sellPackageAction } from "../../pt/actions";
import {
  assignTrainerAction,
  endAssignmentAction,
  reissuePassAction,
  revokePassAction,
} from "../actions";

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CARD_TERMINAL", label: "Card machine" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "OTHER", label: "Other" },
];

/** Check-in history and the member's pass (reissue / cancel). */
export async function AttendanceTab({
  ctx,
  memberId,
  branchId,
}: {
  ctx: AuthContext;
  memberId: string;
  branchId: string;
}) {
  const { deps } = services();
  const canSee = hasPermission(ctx, "attendance.view", { branchId });
  const rows = canSee ? await memberAttendance(deps, ctx, memberId, 30) : [];
  const pass = await getPassStatus(deps, ctx, memberId);
  const canEdit =
    isTenantWritable(ctx) && hasPermission(ctx, "members.edit", { branchId });
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {!canSee ? (
          <Alert tone="info">
            You don&apos;t have access to check-in history.
          </Alert>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No check-ins yet"
            description="Scans of the member's card and manual check-ins appear here."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
              >
                <span className={r.voided ? "text-muted line-through" : ""}>
                  {when(r.occurredAt, ctx.timezone)} · {r.branch}
                  <span className="block text-xs text-muted">
                    {r.method === "QR" ? "QR scan" : "By hand"}
                    {r.reason ? ` · ${r.reason}` : ""}
                    {r.rejectMessage ? ` · ${r.rejectMessage}` : ""}
                  </span>
                </span>
                {r.result === "ACCEPTED" ? (
                  <Badge tone={r.overridden ? "warning" : "success"}>
                    {r.type === "CHECK_OUT" ? "Out" : "In"}
                    {r.overridden ? " (override)" : ""}
                  </Badge>
                ) : (
                  <Badge tone="danger">Refused</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Card className="flex flex-col gap-3">
        <CardTitle>Digital pass</CardTitle>
        {!pass ? (
          <p className="text-sm text-muted">
            Issued automatically the first time the member opens their card in
            the app.
          </p>
        ) : pass.status === "ACTIVE" ? (
          <p className="text-sm">
            <Badge tone="success">Active</Badge> since{" "}
            {when(pass.issuedAt, ctx.timezone)}
          </p>
        ) : (
          <p className="text-sm">
            <Badge tone="danger">Cancelled</Badge> {pass.revokedReason}
          </p>
        )}
        {canEdit && pass && (
          <div className="flex flex-wrap gap-2">
            <ConfirmDialog
              trigger="Issue new pass"
              triggerVariant="outline"
              title="Issue a new pass?"
              description="The old code stops working at once (lost phone, shared screenshot). The app picks up the new one next time it's online."
              confirmLabel="Issue new pass"
              confirmVariant="primary"
              formAction={reissuePassAction}
              fields={{ memberId }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Reason
                <input
                  name="reason"
                  required
                  minLength={3}
                  className="h-10 rounded-md border border-border bg-surface px-3"
                />
              </label>
            </ConfirmDialog>
            {pass.status === "ACTIVE" && (
              <ConfirmDialog
                trigger="Cancel pass"
                title="Cancel this pass?"
                description="Scans are refused until you issue a new one."
                confirmLabel="Cancel pass"
                formAction={revokePassAction}
                fields={{ memberId }}
              >
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Reason
                  <input
                    name="reason"
                    required
                    minLength={3}
                    className="h-10 rounded-md border border-border bg-surface px-3"
                  />
                </label>
              </ConfirmDialog>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Trainers (with history) and PT packages: sell, book sessions. */
export async function TrainingTab({
  ctx,
  memberId,
  branchId,
  active,
}: {
  ctx: AuthContext;
  memberId: string;
  branchId: string;
  active: boolean;
}) {
  const { deps } = services();
  const writable = isTenantWritable(ctx);
  const [assignments, trainers] = [
    await memberTrainers(deps, ctx, memberId),
    await listTrainers(deps, ctx).catch(() => []),
  ];
  let balances: Awaited<ReturnType<typeof memberPtBalances>> = [];
  let packages: Awaited<ReturnType<typeof listPtPackages>> = [];
  let ptError: string | null = null;
  try {
    balances = await memberPtBalances(deps, ctx, memberId);
    packages = await listPtPackages(deps, ctx);
  } catch (err) {
    if (isAppError(err)) ptError = err.message;
    else throw err;
  }
  const canAssign =
    writable && hasPermission(ctx, "trainers.assign", { branchId });
  const canSell =
    writable && active && hasPermission(ctx, "memberships.sell", { branchId });
  const canCollect = hasPermission(ctx, "billing.collect", { branchId });
  const canBook = writable && hasPermission(ctx, "pt.manage", { branchId });
  const current = assignments.filter((a) => a.current);
  const bookable = balances.filter(
    (b) => b.status === "ACTIVE" && b.bookable > 0,
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="flex flex-col gap-3">
        <CardTitle>Trainers</CardTitle>
        {assignments.length === 0 ? (
          <p className="text-sm text-muted">No trainer assigned.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span>
                  <span className="font-medium">{a.trainer.displayName}</span>
                  <span className="block text-xs text-muted">
                    since {when(a.startedAt, ctx.timezone)}
                    {a.endedAt
                      ? ` · ended ${when(a.endedAt, ctx.timezone)} (${a.endReason})`
                      : ""}
                  </span>
                </span>
                {a.current && canAssign ? (
                  <ConfirmDialog
                    trigger="Unassign"
                    title={`Unassign ${a.trainer.displayName}?`}
                    description="The history is kept."
                    confirmLabel="Unassign"
                    formAction={endAssignmentAction}
                    fields={{ memberId, assignmentId: a.id }}
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
                ) : (
                  <Badge tone={a.current ? "success" : "neutral"}>
                    {a.current ? "Current" : "Past"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAssign && trainers.length > 0 && (
          <form
            action={assignTrainerAction}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="memberId" value={memberId} />
            <SelectField
              label="Assign a trainer"
              name="trainerId"
              options={trainers
                .filter((t) => !current.some((c) => c.trainer.id === t.id))
                .map((t) => ({ value: t.id, label: t.displayName }))}
            />
            <SubmitButton variant="outline">Assign</SubmitButton>
          </form>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle>Personal training</CardTitle>
        {ptError ? (
          <Alert tone="info">{ptError}</Alert>
        ) : balances.length === 0 ? (
          <p className="text-sm text-muted">No PT packages.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {balances.map((b) => (
              <li key={b.id} className="py-2">
                <p className="font-medium">
                  {b.name}{" "}
                  <Badge
                    tone={
                      b.status === "ACTIVE"
                        ? "success"
                        : b.status === "PENDING_PAYMENT"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {b.status === "PENDING_PAYMENT"
                      ? "Waiting for payment"
                      : b.status.toLowerCase()}
                  </Badge>
                </p>
                <p className="text-xs text-muted">
                  {b.left}/{b.sessionsTotal} left · {b.scheduled} booked
                  {b.expiresOn ? ` · use by ${day(b.expiresOn)}` : ""}
                  {b.trainer ? ` · ${b.trainer.displayName}` : ""}
                  {b.invoice ? (
                    <>
                      {" · "}
                      <a
                        className="text-primary underline"
                        href={`/invoices/${b.invoice.id}`}
                      >
                        {b.invoice.number}
                      </a>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
        {canBook && bookable.length > 0 && trainers.length > 0 && (
          <ActionForm
            action={bookAppointmentAction}
            className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2"
          >
            <input
              type="hidden"
              name="back"
              value={`/members/${memberId}?tab=training`}
            />
            <SelectField
              label="Package"
              name="balanceId"
              options={bookable.map((b) => ({
                value: b.id,
                label: `${b.name} (${b.bookable} to book)`,
              }))}
            />
            <SelectField
              label="Trainer"
              name="trainerId"
              defaultValue={bookable[0]?.trainer?.id ?? current[0]?.trainer.id}
              options={trainers.map((t) => ({
                value: t.id,
                label: t.displayName,
              }))}
            />
            <FormField
              label="Date"
              name="date"
              type="date"
              required
              defaultValue={todayIn(ctx.timezone)}
            />
            <FormField label="Time" name="time" type="time" required />
            <div>
              <SubmitButton>Book PT session</SubmitButton>
            </div>
          </ActionForm>
        )}
        {canSell && packages.length > 0 && (
          <ActionForm
            action={sellPackageAction}
            className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2"
          >
            <input type="hidden" name="memberId" value={memberId} />
            <SelectField
              label="Sell a package"
              name="packageId"
              options={packages.map((p) => ({
                value: p.id,
                label: `${p.name}: ${p.sessionCount} sessions, ${inr(p.priceMinor)}`,
              }))}
            />
            <SelectField
              label="Trainer (optional)"
              name="trainerId"
              placeholder="Any"
              options={trainers.map((t) => ({
                value: t.id,
                label: t.displayName,
              }))}
            />
            {canCollect && (
              <>
                <FormField
                  label="Paid now (₹, optional)"
                  name="payAmount"
                  inputMode="decimal"
                />
                <SelectField
                  label="Method"
                  name="payMethod"
                  placeholder="—"
                  options={METHODS}
                />
                <FormField label="Reference (UPI/bank)" name="payReference" />
              </>
            )}
            <div className="self-end">
              <SubmitButton variant="outline">Sell package</SubmitButton>
            </div>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
