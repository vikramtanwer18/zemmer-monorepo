# M6 — Growth Automation: WhatsApp, Consent, Campaigns, Automation Engine, Retention

**Goal:** each gym connects its **own** WhatsApp Business Account and sends compliant template messages
(reminders, follow-ups, campaigns) to consenting contacts; a reliable rule-based automation engine reacts to
business events; and a retention dashboard shows who needs attention and what was recovered.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` **D-12**, D-05, D-10 (reminders link to payments)
- `docs/KPI_DEFINITIONS.md` (at-risk member, recovery metrics)
- `MASTER_SPEC.md` Module 11, Module 12, Module 13, Module 19, §12, §13
- Meta WhatsApp Cloud API docs (fetch current): messages, templates, webhooks & `X-Hub-Signature-256`, phone-number/WABA management, messaging limits & quality, pricing categories, Embedded Signup. Confirm field names and limits; don't rely on memory.

## Data model (confirm before migrating)
`WhatsAppAccount` (tenantId, wabaId, phoneNumberId, displayPhone, accessTokenEnc, connectionMethod MANUAL|EMBEDDED_SIGNUP, status, quality rating, messaging limit tier, lastSyncedAt), `MessageTemplate` (synced: name, language, category, status, components, variable schema), `ContactConsent` (from M2 — extend for WhatsApp), `SuppressionRecord` (tenant-wide, channel, reason OPT_OUT|BLOCKED|BOUNCED|MANUAL), `Conversation` + `InboundMessage` (minimal), `OutboundMessage` (template, variables, recipient, status QUEUED|SENT|DELIVERED|READ|FAILED, provider message id, error, cost category), `MessageEvent`, `Segment` (saved filter definition, Zod-validated DSL — no raw SQL), `Campaign` (extend M5: audience segment, template, variable mapping, schedule, status, throttle), `CampaignRecipient`, `AutomationWorkflow`, `AutomationExecution` (+ step results), `RetentionRule` (tenant thresholds), `RetentionFlag`, `RecoveryOutcome`.

## Build (in this order)

### 1. WhatsApp connection (D-12)
- **Manual Connect:** form for WABA ID, phone number ID, system-user access token; verify via live API calls (fetch phone number + WABA); subscribe the app to the WABA webhooks; encrypted storage; status card (connected, display number, quality, limit tier). Clear setup guide page with screenshots placeholders and the exact permissions the token needs.
- **Embedded Signup:** implement behind a platform feature flag + platform config (Meta app id, config id) so it can be switched on once the operator's Tech Provider approval lands. Until then show "coming soon" — never a broken flow.
- Single webhook endpoint (verify token handshake + `X-Hub-Signature-256` with the Meta app secret) → route by WABA/phone number id to the tenant → dedupe → queue.
- WhatsApp adapter behind `MessagingChannel` interface with a **fake** for tests.

### 2. Templates & consent
- Template sync job (on connect + nightly + manual), status tracking, variable schema extraction. Creating templates in-app is optional; at minimum deep-link to Meta's manager.
- Consent rules: MARKETING templates only to contacts with recorded WhatsApp marketing consent; UTILITY (reminders, payment links) need service consent; any opt-out keyword (STOP, UNSUBSCRIBE, configurable, multilingual incl. Hindi transliterations) inbound → suppression across all future campaigns, confirmation reply where allowed. Sending checks consent + suppression **at send time**, not just at campaign creation.
- Free-form text only inside the 24-hour customer service window; otherwise template only. Enforced in the adapter.

### 3. Sending & delivery
- Send queue per tenant respecting the account's rate limits and tier; retries with backoff for retryable errors; permanent failures recorded with reason; delivery/read status from webhooks; idempotent per `(campaignRecipientId)` or `(automationExecutionStepId)`.
- Notification service (M2) gets a WhatsApp channel: payment links (M4), renewal and dues reminders, class reminders, trial reminders — each mapped to an approved template chosen in settings.
- Minimal inbox: inbound messages listed per contact, linked to lead/member by phone, reply within 24 h window, assign to staff. (Full shared inbox is out of scope.)

### 4. Campaigns
- Segment builder over safe fields (status, plan, branch, expiry window, last visit, lead stage, tags, consent) → preview count + sample → choose template → map variables to fields (validated) → schedule or send now → throttled send → live stats (queued/sent/delivered/read/failed/opted-out) → attribution: renewals/payments/conversions within N days by recipients.
- Test-send to staff numbers. Cancel a scheduled campaign. Every campaign launch requires `marketing.send` and shows estimated recipient count and message category before confirming.

### 5. Automation engine (predefined, no user code)
- Triggers (subscribe to outbox events from M2–M5 + scheduled scans): lead created, lead uncontacted SLA, trial booked, trial attended/no-show, membership purchased, membership expiring (N days), membership expired, payment failed/overdue (N days), attendance drop below threshold, class booking cancelled, referral converted (M7 emits later).
- Conditions: typed predicates on event + entity fields (branch, plan, amount, segment membership).
- Actions: create follow-up task, assign staff, send template message (consent-checked), in-app notification, owner alert, update lead stage, wait/delay, request human approval (pauses execution until approved).
- Workflow definitions stored as validated JSON; versioned; enable/disable; dry-run against the last 7 days of events to preview who would be affected.
- Execution: one `AutomationExecution` per (workflow version, trigger event id) — unique constraint prevents duplicates; steps idempotent; retries; failures visible with reason; per-member rate limit (e.g. max 1 automated marketing message/day).
- Ship ready-made templates: "Expiry reminder sequence", "Overdue payment follow-up", "New lead speed-to-lead", "Trial no-show rescue", "Win-back 30 days after expiry".

### 6. Retention & revenue recovery
- Tenant-configurable rules (no visit in N days, visits down X% vs previous 4 weeks, expiring in N days without renewal, overdue > N days, unused class credits, unanswered trial follow-up). Nightly job computes `RetentionFlag`s with **which rule fired**.
- Retention dashboard: lists by reason with recommended next action (call, renewal offer, template message), one-click create task / send template; outcome tracking.
- Recovery metrics (add to KPI doc): renewals after flag/reminder within N days, overdue amount recovered, reactivated members, conversions from automations — clearly labelled as associated, not causal.

## Tests required
- Unit: segment DSL compilation (no injection), consent/suppression gate, 24-h window rule, workflow condition evaluation, rate limiting.
- Integration (fake WhatsApp): forged Meta webhook rejected; events for WABA X never touch tenant Y; STOP inbound → no further marketing sends, even for already-scheduled campaigns; duplicate trigger event → single execution; retry after transient failure sends once; approval step blocks until approved.
- E2E: connect (fake) WABA → sync templates → create segment → schedule campaign → statuses update → attribution shows a renewal; enable expiry workflow → member hits 7 days → message queued once.
- No real WhatsApp messages in automated tests.

## Acceptance checklist
- [ ] Tenant-owned WABA connected via Manual Connect; Embedded Signup present behind a flag (status doc states whether Meta approval exists).
- [ ] Messaging is tenant-scoped, consent-checked at send time, and honors opt-outs immediately.
- [ ] Workflows execute reliably, are auditable, never double-act, and can require human approval.
- [ ] Retention dashboard shows transparent rule-based flags and recovery outcomes.
- [ ] All checks pass; status doc lists exact Meta prerequisites still outstanding.
