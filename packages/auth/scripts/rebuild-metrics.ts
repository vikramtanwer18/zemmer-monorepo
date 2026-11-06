/**
 * Rebuilds the daily KPI rollup (app.metric_daily) from the live tables. Derived data only: safe
 * to run any time, re-runs overwrite. Days that already have a nightly snapshot keep their
 * active/paused counts; earlier days get them reconstructed from membership dates (flagged).
 *
 *   pnpm metrics:rebuild                       # every gym, last 90 days
 *   pnpm metrics:rebuild -- --days 400         # every gym, last 400 days
 *   pnpm metrics:rebuild -- --tenant iron-temple-jaipur --from 2026-01-01 --to 2026-11-06
 */
import path from "node:path";
import { rebuildMetricsTx } from "@gym/core/metrics";
import { addDays, isLocalDate, todayIn } from "@gym/core/time/dates";
import { createPrismaClient, withTenant } from "@gym/db";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: path.resolve(import.meta.dirname, "../../../.env"),
  quiet: true,
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const appUrl = process.env.DATABASE_URL;
const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!appUrl || !platformUrl) {
  console.error("DATABASE_URL and PLATFORM_DATABASE_URL must be set.");
  process.exit(1);
}
const from = arg("from");
const to = arg("to");
const days = Number(arg("days") ?? 90);
if (
  (from && !isLocalDate(from)) ||
  (to && !isLocalDate(to)) ||
  !Number.isInteger(days) ||
  days < 1 ||
  days > 800
) {
  console.error("Use --from/--to as YYYY-MM-DD, or --days 1..800.");
  process.exit(1);
}
const only = arg("tenant");

const app = createPrismaClient(appUrl);
const platform = createPrismaClient(platformUrl);
try {
  const tenants = await platform.tenant.findMany({
    where: {
      status: { in: ["ACTIVE", "SUSPENDED"] },
      ...(only
        ? /^[0-9a-f-]{36}$/i.test(only)
          ? { id: only }
          : { slug: only }
        : {}),
    },
    select: { id: true, slug: true, timezone: true },
  });
  if (only && !tenants.length) throw new Error(`No active gym "${only}"`);
  const now = new Date();
  for (const t of tenants) {
    const today = todayIn(t.timezone, now);
    const end = to ?? today; // today itself is always read live
    const start = from ?? addDays(end, -days);
    const started = Date.now();
    let n = 0;
    // One short transaction per day (keeps each well inside the transaction timeout).
    for (let d = start; d < end; d = addDays(d, 1)) {
      n += (
        await withTenant(app, t.id, (tx) =>
          rebuildMetricsTx(tx, t.id, t.timezone, d, addDays(d, 1), now),
        )
      ).days;
    }
    console.log(
      `${t.slug}: ${n} day(s) ${start} → ${end} in ${Date.now() - started} ms`,
    );
  }
  console.log(`Rebuilt ${tenants.length} gym(s).`);
} finally {
  await app.$disconnect();
  await platform.$disconnect();
}
