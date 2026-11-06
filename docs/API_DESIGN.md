# API design

Most of the product is used through server actions and server-rendered pages; those are internal.
This file covers the **integration-facing** surface: what a gym's web developer, or another system,
may call. Everything else may change without notice.

The machine-readable description is served by the app at **`/api/public/v1/openapi.json`**
(OpenAPI 3.1, generated from `packages/core/src/crm/openapi.ts`; a unit test keeps it in step with the
validation schema).

## Conventions

- Base path `/api/public/v1`. Breaking changes get a new version path; fields are only added.
- JSON in, JSON out. Errors always look like:
  `{"error": {"code": "VALIDATION_FAILED", "message": "…", "fields": {"phone": ["…"]}}}`.
  Codes are the stable codes from `packages/core/src/errors`: `AUTH_REQUIRED` (401), `FORBIDDEN`
  (403), `ENTITLEMENT_REQUIRED` (402), `VALIDATION_FAILED` (422, or 400 for non-JSON), `CONFLICT` (409),
  `RATE_LIMITED` (429, with `Retry-After`).
- No internal details (stack traces, SQL, other gyms) appear in responses.

## Authentication: tenant API keys

- Created by an owner/admin (`crm.configure`) in **Settings → Leads → Website API**. Each key belongs to
  **one gym and one branch**; the request body can't choose another (unknown fields are refused).
- Format `gk_<prefix 12>_<secret 32+>`. Only the prefix and a SHA-256 of the secret are stored; the full
  key is shown once. The secret is compared in constant time.
- Scopes: `leads.create` (the only one in v1). Revoking a key takes effect on the next request.
- Send as `Authorization: Bearer gk_…`. Keys belong on a server, never in a browser.
- Rate limit: 600 requests per hour per key (`lead-api:key`).
- The gym's plan must include Leads and CRM (`crm.enabled`), else 402.

## `POST /api/public/v1/leads`

Creates a lead in the key's branch, or, when an **open** lead with the same mobile or email exists,
adds the enquiry to it (its latest touch is updated; 200 with `created: false`).

Body (JSON, `additionalProperties: false`): `first_name` (required), `last_name`, `phone`, `email`
(at least one of phone/email), `interest`, `message`, `source` (a source code configured in the gym,
e.g. `website`), `campaign` (a campaign tracking code), `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content`, `referrer`, and **`consent`** `{given: true, text: "<the exact text shown>",
marketing?: boolean}` (required: the person agreed to be contacted; `text` is stored with the lead).

Attribution: `campaign`, else `utm_campaign`, is matched to the gym's campaign codes (case-insensitive);
`source`, else `utm_source` (with aliases such as `fb` → facebook), to its sources, else "Website".

Idempotency: optional `Idempotency-Key` header (8–100 chars). A retry with the same key and body within
24 hours returns the first response with `replayed: true`; the same key with a different body → 409.

Responses: `201 {"id", "created": true}`, `200 {"id", "created": false}` or a replay, and the errors above.

```bash
curl -X POST https://app.example.in/api/public/v1/leads \
  -H "Authorization: Bearer gk_xxxxxxxxxxxx_…" -H "Content-Type: application/json" \
  -H "Idempotency-Key: enquiry-12345" \
  -d '{"first_name":"Asha","phone":"9876543210","utm_campaign":"diwali-2026",
       "consent":{"given":true,"text":"I agree that Iron Temple may contact me about my enquiry."}}'
```

## Hosted and embedded capture forms (no key needed)

- Hosted: `/l/{gymSlug}/{formKey}`. Query `utm_*` and `referrer` are kept with the lead. The page can't
  be framed (`X-Frame-Options: DENY`).
- Embedded: `<div data-gym-lead-form="https://app…/l/{gymSlug}/{formKey}"></div>` plus
  `<script src="https://app…/embed/lead-form.js" async></script>`. The script adds an iframe of
  `/l/{gymSlug}/{formKey}/embed`, passing the host page's UTM tags and referrer. That page is plain HTML
  with `Content-Security-Policy: frame-ancestors 'self' <the form's allowed sites>; default-src 'none'`.
- The form key alone decides the gym and branch. Abuse controls: honeypot field, 10 submissions per
  hour per IP and 300 per hour per form, a consent tick is required, and a captcha hook
  (`submitPublicForm({captcha})`) is ready for when spam appears.

## Domain events (internal contract for M6 automations)

Not an HTTP API, but a stable contract: events are written to the outbox (topic `event`) in the same
transaction as the change and delivered to each handler at most once (`EventConsumption`). Names and
data shapes: `packages/core/src/events/index.ts` (`lead.created`, `lead.stage_changed`, `lead.assigned`,
`lead.uncontacted_sla_breached`, `lead.lost`, `lead.converted`, `trial.booked`, `trial.attended`,
`trial.no_show`, `trial.cancelled`; M6 adds `membership.activated`, `class.booking_cancelled`,
`retention.flagged`; M7 adds `attendance.checked_in` and `referral.converted`). Fields may be added; existing ones are not renamed. M6 automations subscribe through
the `automation.trigger` handler (`packages/core/src/automation`).

## Other routes (internal, not for integrators)

**WhatsApp (Meta) webhook**: `GET|POST /api/webhooks/whatsapp`, one URL for every gym, configured once in the
operator's Meta app (fields `messages`, `message_template_status_update`). GET answers Meta's handshake
(`hub.mode=subscribe`, `hub.verify_token` = `META_WEBHOOK_VERIFY_TOKEN`, echoes `hub.challenge`; else 403).
POST: 401 without a valid `X-Hub-Signature-256`, 400 for an unreadable body, otherwise 200
`{ ok, accepted, duplicates }` quickly (items are stored once and processed by the worker; Meta retries anything else).

**Exports download** (M2, M5, M8): `GET /api/exports/{dataJobId}` — signed-in staff of the same gym, the
matching permission (`members.export` / `leads.export` / `reports.export`; report exports only by the person who
asked), file not expired (24 h) → 302 to a 60-second private storage URL; audited (`*.export_downloaded`). 404 otherwise.

**Copilot** has no public API: the staff app calls the server action `askCopilotAction({ question, history })` →
`CopilotAnswer { answer, mode, outcome, ungrounded, warning, sources[], results[], proposals[], quota }`. Errors
follow the usual codes: 402 `ENTITLEMENT_REQUIRED` / `QUOTA_EXCEEDED`, 403, 409 (Copilot switched off), 429.

Razorpay webhooks (`/api/webhooks/razorpay/{integrationId}`, admin `/api/webhooks/razorpay-platform`)
and the signed web → admin billing calls (`/api/internal/billing/*`) are documented in
`docs/SECURITY.md` and `docs/RUNBOOKS.md`.
