# Staging on AWS (M4) — prepared, not yet deployed

Status: **files ready; nothing has been created in AWS.** Creating these resources costs money and
needs AWS access, so it waits for the client's go-ahead (CLAUDE.md: ask before deploys).

## Shape

```
            Route 53 (app.staging…, admin.staging…)
                          │
   EC2 t3.medium (Docker) ── caddy (TLS) ── web :3000 · admin :3001 · worker :4100
        │ instance role: Secrets Manager (one secret), S3 bucket, SES send, CloudWatch Logs
        ├── RDS PostgreSQL 18 (db.t4g.small, private subnet, 7-day backups + PITR, encrypted)
        ├── ElastiCache Redis 7/8 (cache.t4g.micro, private subnet, TLS)
        ├── S3 bucket gym-staging-uploads (private, block public access, SSE-S3, versioning)
        └── SES (verified domain; sandbox until production access is granted)
```

Region `ap-south-1` (Mumbai). Rough cost at on-demand prices: about USD 70–90 a month
(EC2 ~30, RDS ~30, ElastiCache ~12, the rest small). Check current prices before creating.

## One-time setup (in this order)

1. **Network**: a VPC with 2 public subnets (EC2) and 2 private subnets (RDS, ElastiCache).
   Security groups: EC2 accepts 80/443 from anywhere and SSH only via SSM Session Manager (no port 22);
   RDS 5432 and Redis 6379 accept only the EC2 security group.
2. **RDS**: PostgreSQL 18, database `gym`, automated backups 7 days (gives point-in-time restore),
   storage encryption on, deletion protection on. Then, from the EC2 host:
   `psql "$MASTER_URL" -v app_pw=… -v platform_pw=… -v owner_pw=… -f infra/staging/roles.sql`.
3. **ElastiCache** Redis with in-transit encryption; `REDIS_URL=rediss://…`.
4. **S3** bucket (private) and a CORS rule allowing `POST` from `https://<APP_HOST>` (logo/photo uploads).
5. **SES**: verify the sending domain (DKIM), request production access; until then only verified
   addresses receive mail.
6. **Secrets Manager** secret `gym-saas/staging` (JSON). Keys = every variable in `.env.example`, with:
   - `NODE_ENV=production`, `APP_URL=https://<APP_HOST>`, `ADMIN_URL=https://<ADMIN_HOST>`,
     `APP_HOST`, `ADMIN_HOST`, `ACME_EMAIL` (for Caddy)
   - fresh random values (`openssl rand -base64 32`) for `AUTH_SECRET`, `ADMIN_AUTH_SECRET`,
     `DATA_ENCRYPTION_KEY`, `PLATFORM_INTERNAL_SECRET` — all different, never the dev values
   - `PAYMENTS_FAKE_ENABLED=false` (the app refuses to start with it on in production)
   - `DATABASE_URL` (gym_app), `PLATFORM_DATABASE_URL` (gym_platform), `MIGRATION_DATABASE_URL` (gym_owner),
     all with `?sslmode=require`
   - `EMAIL_PROVIDER=ses`, `SES_REGION=ap-south-1`, `EMAIL_FROM`; S3 vars without `S3_ENDPOINT` /
     `S3_FORCE_PATH_STYLE` (the instance role supplies credentials)
7. **EC2**: Amazon Linux 2023, Docker + compose plugin, `jq`, AWS CLI, git; clone the repo; attach the
   instance role. Then `infra/staging/render-env.sh gym-saas/staging` and `infra/staging/release.sh <tag>`.
8. **First admin**: `pnpm platform:create-admin` from a one-off container (see RUNBOOKS "First admin").
9. **Razorpay** (test mode first): platform keys in Admin → Billing → Payment account; webhook
   `https://<ADMIN_HOST>/api/webhooks/razorpay-platform` with the `subscription.*` events.
   Each pilot gym enters its own keys in Settings → Online payments, which shows its webhook URL.

## Monitoring and alerts

- Logs: every container ships JSON logs to CloudWatch Logs group `/gym-saas/staging` (awslogs driver).
- Uptime: Route 53 health checks on `https://<APP_HOST>/api/health` and `https://<ADMIN_HOST>/api/health`
  (both check the database) → CloudWatch alarm → SNS email.
- Metric filters on the log group → alarms (SNS email to the on-call address):
  | Alarm                     | Filter                                                                    | Threshold     |
  | ------------------------- | ------------------------------------------------------------------------- | ------------- |
  | Webhooks rejected         | `{ $.msg = "webhook rejected" \|\| $.msg = "platform webhook rejected" }` | ≥ 5 in 15 min |
  | Jobs failing              | `{ $.msg = "job failed" }`                                                | ≥ 3 in 15 min |
  | Reconciliation mismatches | `{ $.msg = "reconciliation found differences" }`                          | ≥ 1 in 1 h    |
  | Server errors             | `{ $.level >= 50 }`                                                       | ≥ 10 in 5 min |
- Admin → System health shows queue depths, failed jobs (retry), and webhook counters.
- Error tracking (Sentry or similar) is not wired yet; logs + alarms cover staging.

## Backups and the restore drill

RDS automated backups (7 days, PITR). The drill is in `docs/RUNBOOKS.md` → "Restore from backup";
record each drill's date, restore time and row-count check in `docs/IMPLEMENTATION_STATUS.md`.
**No drill has been run yet** (needs the RDS instance).
