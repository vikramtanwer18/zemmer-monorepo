import { myEngagement } from "@gym/core/engagement";
import { getMemberHome } from "@gym/core/members";
import {
  Alert,
  Badge,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  LinkButton,
  SubmitButton,
} from "@gym/ui";
import { onlinePaymentsEnabled } from "@gym/core/payments";
import type { Metadata } from "next";
import { Flash } from "@/components/flash";
import { renewOnlineAction } from "./pay/actions";
import { day, inr } from "@/lib/format";
import { requireMember } from "@/lib/member-session";
import { services } from "@/lib/services";

export const metadata: Metadata = { title: "Home" };

const STATUS: Record<
  string,
  { label: string; tone: "success" | "warning" | "info" | "neutral" }
> = {
  ACTIVE: { label: "Active", tone: "success" },
  PAUSED: { label: "Frozen", tone: "info" },
  PENDING_PAYMENT: { label: "Waiting for payment", tone: "warning" },
};

export default async function MemberHomePage({
  searchParams,
}: PageProps<"/m">) {
  const { mctx } = await requireMember("/m/");
  const sp = await searchParams;
  const home = await getMemberHome(services().db, mctx);
  const online = await onlinePaymentsEnabled(services().deps, mctx);
  const eng = await myEngagement(services().deps, mctx);
  const current = home.current;
  const canRenewOnline =
    online.enabled &&
    !!current &&
    !current.renewsOn &&
    (current.status === "ACTIVE" || current.status === "PAUSED");
  const status = current
    ? (STATUS[current.status] ?? {
        label: current.status,
        tone: "neutral" as const,
      })
    : null;

  return (
    <>
      <h1 className="text-2xl font-semibold">Hi, {home.name}</h1>
      <p className="-mt-3 text-sm text-muted">Member no. {home.memberCode}</p>
      <Flash params={sp} />

      <a href="/m/workouts" className="block" data-testid="home-train">
        <Card className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted">Weekly streak</p>
            <p className="text-2xl font-semibold">
              {eng.streak.currentWeeks} wk
            </p>
          </div>
          <div className="text-right text-sm">
            {eng.points !== null && (
              <p className="font-medium">{eng.points} points</p>
            )}
            {eng.unreadFeedback > 0 && (
              <Badge tone="info">
                {eng.unreadFeedback} new from your trainer
              </Badge>
            )}
            <p className="text-primary underline">Train →</p>
          </div>
        </Card>
      </a>
      <LinkButton href="/m/card" size="lg" className="w-full">
        Show my check-in card
      </LinkButton>
      <nav
        aria-label="More"
        className="grid grid-cols-3 gap-2 text-center text-sm"
      >
        <a
          href="/m/classes"
          className="rounded-lg border border-border bg-surface px-2 py-3 font-medium"
        >
          Classes
        </a>
        <a
          href="/m/check-ins"
          className="rounded-lg border border-border bg-surface px-2 py-3 font-medium"
        >
          Check-ins
        </a>
        <a
          href="/m/pt"
          className="rounded-lg border border-border bg-surface px-2 py-3 font-medium"
        >
          Personal training
        </a>
      </nav>

      {home.outstandingMinor > 0 && (
        <Alert tone="warning" title={`${inr(home.outstandingMinor)} due`}>
          {online.enabled ? (
            <a className="font-medium underline" href="/m/invoices">
              Pay now
            </a>
          ) : (
            <>
              Pay at the front desk.{" "}
              <a className="font-medium underline" href="/m/invoices">
                See invoices
              </a>
            </>
          )}
        </Alert>
      )}

      {current ? (
        <Card>
          <div className="flex items-start justify-between gap-2">
            <CardTitle>{current.plan}</CardTitle>
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>
          <CardDescription>
            {day(current.startDate)} to {day(current.endDate)}
          </CardDescription>
          {current.status !== "PENDING_PAYMENT" && (
            <p
              className="mt-4 text-4xl font-semibold"
              aria-label={`${current.daysLeft} days left`}
            >
              {current.daysLeft}
              <span className="ml-2 text-base font-normal text-muted">
                day{current.daysLeft === 1 ? "" : "s"} left
              </span>
            </p>
          )}
          <p className="mt-2 text-sm text-muted">
            {current.renewsOn
              ? `Renewal starts ${day(current.renewsOn)}.`
              : canRenewOnline
                ? `Ends ${day(current.endDate)}.`
                : `Ends ${day(current.endDate)}. Renew at the front desk.`}
          </p>
          {canRenewOnline && (
            <form action={renewOnlineAction} className="mt-3">
              <input type="hidden" name="membershipId" value={current.id} />
              <input type="hidden" name="back" value="/m/" />
              <SubmitButton variant="outline" className="w-full">
                Renew and pay online
              </SubmitButton>
            </form>
          )}
        </Card>
      ) : (
        <EmptyState
          title="No active membership"
          description={
            online.enabled
              ? "Pick a plan and pay in the app, or visit the front desk."
              : "Visit the front desk to start or renew a plan."
          }
          action={
            online.enabled ? (
              <LinkButton href="/m/plans">See plans</LinkButton>
            ) : undefined
          }
        />
      )}

      {home.upcoming.length > 0 && (
        <section aria-labelledby="upcoming" className="flex flex-col gap-2">
          <h2 id="upcoming" className="text-sm font-semibold">
            Coming up
          </h2>
          {home.upcoming.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-md border border-border bg-surface p-3 text-sm"
            >
              <span>{m.plan}</span>
              <span className="text-muted">from {day(m.startDate)}</span>
            </div>
          ))}
        </section>
      )}

      {home.creditMinor > 0 && (
        <p className="text-sm text-muted">
          You have {inr(home.creditMinor)} credit. It's used on your next
          invoice.
        </p>
      )}

      <LinkButton href="/m/invoices" variant="outline">
        Payments and invoices
      </LinkButton>
      {online.enabled && current && (
        <a
          href="/m/plans"
          className="text-center text-sm text-primary underline"
        >
          Other plans
        </a>
      )}
      <a href="/m/privacy" className="text-center text-xs text-muted underline">
        Privacy and your data
      </a>
    </>
  );
}
