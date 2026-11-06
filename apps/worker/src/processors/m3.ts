import {
  closeEndedSessions,
  materializeAllTemplates,
  sendClassReminders,
} from "@gym/core/classes";
import { enqueue } from "@gym/core/jobs";
import { expirePtBalances } from "@gym/core/staff";
import { todayIn } from "@gym/core/time/dates";
import type { JobContext } from "../context";

const TICK_MS = 15 * 60 * 1000;

/** Every 15 minutes: one classes tick per active tenant (idempotent per tenant per slot). */
export async function floorScan(
  ctx: JobContext<"platform", "platform.floor-scan">,
) {
  const platform = ctx.platform();
  const { redis } = ctx.services();
  const tenants = await platform.db.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  const slot = Math.floor(Date.now() / TICK_MS);
  for (const t of tenants) {
    await enqueue(redis, "classes", "classes.tick", {
      tenantId: t.id,
      actor: { type: "system" },
      idempotencyKey: `tick-${t.id}-${slot}`,
      data: {},
    });
  }
  return { tenants: tenants.length };
}

/** Ended classes → COMPLETED (bookings left BOOKED become NO_SHOW); reminders before classes. */
export async function classesTick(ctx: JobContext<"classes", "classes.tick">) {
  const tenantId = ctx.envelope.tenantId!;
  const now = new Date();
  const closed = await ctx.tenantDb((tx) =>
    closeEndedSessions(tx, tenantId, now),
  );
  const reminders = await ctx.tenantDb((tx) =>
    sendClassReminders(tx, tenantId, now),
  );
  if (closed.sessions || reminders.reminded)
    ctx.log.info({ ...closed, ...reminders }, "classes tick");
  return { ...closed, ...reminders };
}

/** Daily per tenant: extend schedules 8 weeks ahead; expire PT packages past their last day. */
export async function classesDaily(
  ctx: JobContext<"classes", "classes.daily">,
) {
  const tenantId = ctx.envelope.tenantId!;
  const { date } = ctx.envelope.data;
  const schedule = await ctx.tenantDb((tx) =>
    materializeAllTemplates(tx, tenantId, date, new Date()),
  );
  const pt = await ctx.tenantDb((tx) => expirePtBalances(tx, tenantId, date));
  if (schedule.created || pt.expired)
    ctx.log.info({ ...schedule, ...pt }, "classes daily");
  return { ...schedule, ...pt };
}

/** Called from the hourly platform daily-scan, next to the membership job. */
export async function enqueueClassesDaily(
  redis: Parameters<typeof enqueue>[0],
  tenantId: string,
  timezone: string,
  now: Date,
) {
  const date = todayIn(timezone, now);
  await enqueue(redis, "classes", "classes.daily", {
    tenantId,
    actor: { type: "system" },
    idempotencyKey: `classes-daily-${tenantId}-${date}`,
    data: { date },
  });
}
