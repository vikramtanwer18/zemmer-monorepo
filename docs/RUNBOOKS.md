# Runbooks

Operational procedures for staging and production (AWS layout in `infra/staging/README.md`).
Commands run on the EC2 host from the repo root unless stated. Never paste secrets into tickets,
chat or shell history; read them from Secrets Manager.

## Deploy

1. Check CI is green for the commit; tag it (`git tag v0.4.0 && git push --tags`).
2. On the host: `infra/staging/render-env.sh gym-saas/staging` (only if secrets changed).
3. `infra/staging/release.sh v0.4.0` — runs `prisma migrate deploy` (owner role), then rebuilds and
   restarts web, admin and worker.
4. Check: both `/api/health` return `{"status":"ok"}`; Admin → System health shows no new failed jobs;
   sign in to both apps.

Migrations are additive (expand → contract): a release never drops or renames something the previous
release still uses. Destructive steps go in a later release, after the code stops using them.

## Roll back

1. `infra/staging/release.sh <previous tag>` — the previous code runs against the newer schema, which
   the expand → contract rule keeps compatible.
2. Do **not** roll back migrations. If a migration itself is wrong, write a new forward migration.
3. If data was damaged, see "Restore from backup" (restore to a new instance, compare, then decide).

## Restore from backup (drill: do one before the pilot, then every quarter)

1. RDS console → the instance → "Restore to point in time" → a time just before the incident (or the
   latest restorable time for a drill). New identifier `gym-staging-restore-YYYYMMDD`, same subnet
   group and security group, no public access.
2. Wait until "Available" (note how long it took).
3. From the host: `psql "<restored url>" -c "select count(*) from app.member_profile" -c "select count(*) from app.gym_payment" -c "select max(created_at) from app.audit_log"` and compare with the live database.
4. For a real recovery: stop the containers, point the three `*_DATABASE_URL` values at the restored
   instance (Secrets Manager), `render-env.sh`, `release.sh <current tag>`. Payments made at Razorpay
   after the restore point are pulled back in by reconciliation (nightly, or Payments → Reconciliation →
   "Check with Razorpay now" in each gym).
5. Drill only: delete the restored instance. Record date, restore point, time taken and the counts in
   `docs/IMPLEMENTATION_STATUS.md`.

## Rotate a gym's Razorpay secret

When a gym's key secret or webhook secret leaks or is regenerated in their Razorpay dashboard:

1. Gym owner (or admin with `settings.payments`): Settings → Online payments → enter the new key id,
   key secret and webhook secret → Save. The keys are checked with Razorpay before anything changes;
   the old integration is closed and the new one gets a **new webhook URL** (shown on the page).
2. In the Razorpay dashboard: update the webhook to the new URL and secret.
3. Open payment links made with the old keys still settle: reconciliation fetches them with the
   integration that created them. Webhooks sent to the old URL are refused (counted on System
   health); reconciliation covers those payments.
4. The audit log records `payment_integration.rotated` with the new key id and last 4 characters
   (never the secrets).

Platform key (gym subscriptions): Admin → Billing → Payment account and prices → replace account,
then update the platform webhook secret in Razorpay.

Rotating the **encryption key** (`DATA_ENCRYPTION_KEY`): put the old value in
`DATA_ENCRYPTION_KEY_PREVIOUS`, the new one in `DATA_ENCRYPTION_KEY`, deploy; records are readable
with either. (A re-encryption job is not built yet; keep `_PREVIOUS` until it is.)

## Replay a failed webhook

Gym payment webhooks are stored before they are processed, and processing is idempotent.

1. Admin → System health → queue `payments`: find the failed `payments.webhook` job → **Retry**.
2. Or, without the console: Payments → Reconciliation → "Check with Razorpay now" in that gym. It also
   reprocesses stuck events and fetches every open link from Razorpay (the source of truth).
3. If Razorpay never delivered it: in the Razorpay dashboard → Webhooks → the event → "Resend". The
   duplicate check (provider event id) makes repeats harmless.

Platform (subscription) webhooks: stored first; the hourly billing job replays any that are stuck or
failed (up to 10 tries). Retry from System health → queue `platform` → `platform.billing-webhook`.

## First admin

`docker run --rm -it --env-file infra/staging/.env.staging -v "$PWD":/repo -w /repo node:24-alpine sh -c "corepack enable && pnpm install --frozen-lockfile && pnpm platform:create-admin"` — prompts for the email and password.

## KPI rollup (M8)

`app.metric_daily` is derived data. The nightly `metrics.rollup` job writes yesterday per gym. After a restore,
a data fix or a definition change, rebuild it (safe to re-run; nightly snapshots are kept):

```
pnpm metrics:rebuild                                  # every gym, last 90 days
pnpm metrics:rebuild -- --tenant <slug-or-id> --days 400
pnpm metrics:rebuild -- --from 2026-01-01 --to 2026-11-01
```

## Connect or switch the AI provider (M8)

1. Admin console → **AI provider**: base URL of any OpenAI-compatible Chat Completions API (https), model id, API key.
   Save (the key is encrypted; only its last 4 characters are shown again).
2. **Test connection**. It runs a tiny completion and a tool-calling probe. "Tool calling works" → full Copilot;
   otherwise gyms get the fallback mode (server-built summaries explained by the model).
3. Tick **Copilot switched on** and save. Gyms see it if their plan has `ai.copilot` (quota `ai.monthly_queries`).
4. Run the eval against it and record the result in `docs/IMPLEMENTATION_STATUS.md` (needs the demo seed):
   `pnpm ai:eval` (or `pnpm ai:eval -- --only expiring-week,overdue`). Reports go to `apps/web/ai-evals/results/`
   (git-ignored: answers contain demo member names).

Changing the URL, model or key clears the last test and needs a new one before switching on. A failing test
switches the Copilot off. To stop it quickly, untick "switched on" and save.
