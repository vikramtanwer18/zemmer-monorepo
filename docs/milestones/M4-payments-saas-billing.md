# M4 — Online Payments, Refunds, SaaS Billing & Staging Launch (Sellable MVP)

**Goal:** each gym connects its own Razorpay account; members buy, renew, and pay balances online from the PWA;
staff send payment links; payments reconcile reliably even when webhooks are duplicated, delayed, or missing;
refunds work. Separately, gyms pay the platform through Fonix/client's Razorpay subscriptions with trials, dunning,
and suspension. The product is deployed to a staging environment on AWS and ready for a pilot gym.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` **D-10**, D-11, D-05 (platform vs tenant data), D-06
- `MASTER_SPEC.md` §5 "SaaS billing versus gym billing", Module 9, §7A items 5–9, §12, §13, §14 (payment security tests), §17, §18
- Razorpay docs (fetch current): Payment Links (incl. partial payments), webhooks & signature verification, refunds, Subscriptions & Plans. Do not rely on memory for event names or payload fields — confirm them.

## Data model (confirm before migrating)
`PaymentIntegration` (tenantId, provider RAZORPAY, mode TEST|LIVE, keyId, keySecretEnc, webhookSecretEnc, status, lastVerifiedAt), `PaymentLink` (tenantId, provider id, invoice ids, amount, partial allowed, status, expiresAt, shortUrl, referenceId unique), extend `GymPayment` with provider ids, `WebhookEvent` (provider, integrationId, eventId unique, type, receivedAt, signatureValid, payload (redacted), status RECEIVED|PROCESSED|FAILED|IGNORED, attempts, error), `Refund` (tenantId, paymentId, amount, reason, status, providerRefundId, creditNoteId), `ReconciliationRun` + items.
Platform: extend `TenantSubscription` (provider subscription id, status, current period, cancelAtPeriodEnd), `PlatformInvoice`, `PlatformPayment`, `PlatformWebhookEvent`, `DunningAttempt`.

## Build (in this order)

### 1. Provider adapter
- `PaymentProvider` interface in `packages/integrations/payments`: `verifyCredentials`, `createPaymentLink`, `fetchPaymentLink`, `fetchPayment`, `createRefund`, `fetchRefund`, `verifyWebhook`, `parseWebhook → NormalizedEvent`. Razorpay implementation + a **fake provider** for tests that can emit signed events, duplicates, and out-of-order sequences.
- Idempotency: pass our own unique `reference_id`/receipt; use idempotency keys where the provider supports them.

### 2. Gym connects Razorpay
- Settings → Payments (permission `settings.payments`): enter key id/secret (test or live), webhook secret; "Verify" calls the provider; show webhook URL `/api/webhooks/razorpay/{integrationId}` and which events to enable. Secrets encrypted (envelope encryption, KEK from env/Secrets Manager), displayed only as last 4. Disconnect/rotate flows audited.

### 3. Collecting online
- **Staff:** "Send payment link" on any open invoice (full or allow partial with minimum), share via copy/email (WhatsApp in M6); cancel link; links expire per setting.
- **Member PWA:** Pay outstanding balance; Renew current membership; Buy a plan (only plans enabled for online purchase and eligible for the member). Flow: create pending invoice (and pending membership for purchases) → create payment link → redirect → return page shows **"Confirming payment…"** and polls our API, never trusting the redirect query string.
- **Webhook endpoint:** read raw body → look up integration → verify signature (reject 400 if invalid, record attempt) → upsert `WebhookEvent` by provider event id (duplicate → 200, no reprocessing) → enqueue processing → 200 fast.
- **Processor (worker):** loads current provider state when the event is ambiguous, creates `GymPayment`, allocates to invoices (partial supported), activates/renews membership per tenant policy, overpayment → member credit, emits notifications — all in one transaction keyed so reprocessing is a no-op. Out-of-order events (e.g. `paid` before `partially_paid`) converge to the same final state.
- **Reconciliation job:** every 15 min, fetch status for links/payments pending longer than N min; nightly full reconciliation per tenant for the previous day; mismatches create a `ReconciliationRun` item and an owner/accountant notification. Staff page lists unreconciled items with a "re-check" action.

### 4. Refunds
- Permission `billing.refund` (Owner/Accountant by default); full or partial; reason required; optional second approval (tenant setting) for amounts above a threshold.
- Online payment → provider refund; manual payment → record manual refund with method. Either way create a credit note (D-11) and adjust membership per cancellation policy. Refund status tracked via webhook + reconciliation. Audited.

### 5. Dues & renewals
- Overdue tracking (aging buckets per KPI doc), member dues list for staff, daily reminder job (email + in-app; respects consent/preferences; WhatsApp added in M6). Renewal reminders link straight to the PWA renew screen.

### 6. SaaS subscription billing (platform)
- Platform Razorpay credentials in `apps/admin` settings (same encryption). Admin maps each `SaasPlan` version to a provider plan id (monthly / 6-month / yearly).
- Owner billing page in `apps/web` (`billing.manage`, Owner only): current plan, trial days left, usage vs quotas, choose plan → provider subscription checkout → status from **verified platform webhooks only**.
- Lifecycle: `TRIALING → ACTIVE → PAST_DUE → GRACE (n days, configurable) → SUSPENDED`, plus cancel at period end and reactivate. Dunning emails at each step. Suspended = read-only + banner; nothing deleted. Upgrades apply immediately; downgrades at period end; over-quota data frozen not deleted.
- Platform invoices with the operator's GSTIN as supplier and the gym's GSTIN (if any) as recipient (B2B). Platform webhook endpoint is separate from tenant webhooks and writes only `platform` tables through a narrowly granted role.
- Admin: subscriptions list, MRR/ARR (definitions in KPI doc), trials ending, past-due list, manual extend-trial/comp with reason (audited).
- Admin: platform usage analytics (active tenants, members and staff per tenant, feature usage from `UsageCounter`) and **platform announcements** (target all tenants or by plan/status; shown as an in-app banner/notification to tenant owners; schedule + expiry).

### 7. Privacy minimum for launch
- Member privacy notice + consent screen in PWA onboarding; "Download my data" (member) and "Request deletion" (creates a staff task; deletion anonymizes personal fields while retaining financial records required by law). Document the retention policy in `docs/SECURITY.md`.

### 8. Staging deployment & operations
- Deploy admin, web, worker containers to EC2 staging (TLS, reverse proxy), RDS with automated backups + PITR, ElastiCache, S3 private buckets, SES. Secrets from Secrets Manager/SSM. Migrations via `db:deploy` in the release step.
- Error monitoring + structured logs shipped to CloudWatch (or chosen tool); uptime checks on `/health`; alert on webhook failure rate, failed jobs, and reconciliation mismatches.
- Runbooks in `docs/RUNBOOKS.md`: deploy, rollback, restore from backup (perform one restore drill and record it), rotate a tenant's payment secret, replay a failed webhook.
- Admin "System health" page: queue depths, failed jobs (retry/inspect), webhook failure counts.

## Tests required
- Unit: normalized-event state machine, allocation for partial sequences, refund math with GST credit notes, dunning schedule.
- Integration (fake provider): **forged signature rejected and nothing written**; **same event delivered 3× → one payment**; `paid` before `partially_paid` → correct final state; webhook missing → reconciliation fixes it; partial then remainder → invoice PAID + membership ACTIVE; overpay → credit; refund webhook updates status once; tenant B's integration id cannot process tenant A's event; platform webhook cannot touch `app` tables.
- E2E (sandbox or fake): member pays balance from PWA → confirming screen → paid; staff sends partial link; owner subscribes to a plan; subscription payment failure → past due → grace → suspended banner.
- Never charge real cards or move real money in tests.

## Acceptance checklist
- [ ] Payment records stay consistent when events are duplicated, delayed, reordered, or missing (tests prove each case).
- [ ] Members can buy, renew, and pay balances online; staff can send links and record manual payments; partial payments allocate correctly.
- [ ] Refunds (online + manual) produce credit notes and correct membership state.
- [ ] SaaS subscription lifecycle works end to end with verified webhooks; SaaS and gym billing share no tables.
- [ ] Staging environment running on AWS with backups verified by a restore drill, monitoring, and runbooks.
- [ ] Pilot-gym checklist in the status doc: what a gym needs to provide (Razorpay keys, GSTIN, plans, member import file).
- [ ] All checks pass; status doc updated, listing any provider features still mocked. **M4 = sellable MVP.**
