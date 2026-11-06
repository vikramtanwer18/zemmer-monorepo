# M5 — CRM: Leads, Pipeline, Trials, Follow-ups, Attribution

**Goal:** a gym captures leads from its website, walk-ins, and phone calls; works them through a configurable
pipeline with assigned follow-up tasks; books and tracks trials; converts leads into paying members; and can see,
end to end, which source/campaign produced each paid membership.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` D-04, D-05, D-07
- `docs/KPI_DEFINITIONS.md` (lead conversion, trial-to-member, campaign attribution)
- `MASTER_SPEC.md` Module 10, Module 12 (only to keep the event names compatible — the engine is M6), §9 CRM entities, §10, §12

## Data model (confirm before migrating)
`LeadStage` (tenant-configurable, each mapped to a fixed **stage category** `NEW|CONTACTED|TRIAL_SCHEDULED|TRIAL_ATTENDED|OFFER_SENT|WON|LOST` so reports never break), `Lead` (tenantId, branchId, name, phone, email, source, campaignId, utm fields, stageId, ownerUserId, score, status OPEN|WON|LOST, lostReasonId, convertedMemberId, convertedMembershipId, firstTouch/lastTouch), `LeadActivity` (call, note, email, stage change, task, system), `LostReason`, `FollowUpTask` (assignee, due, status, linked lead/member), `TrialBooking` (lead, branch, slot or class session, status BOOKED|ATTENDED|NO_SHOW|CANCELLED), `Campaign` (name, channel, dates, budget optional, tracking code), `LeadSource`, `LeadCaptureForm` (fields, branch, consent text, public key), `TenantApiKey` (hashed, scopes: `leads.create`).

## Build (in this order)
1. **Lead entry & list:** manual entry with duplicate detection (phone/email vs leads and members); list with filters (stage, owner, source, campaign, branch, date, overdue tasks) and saved views; lead detail with activity timeline.
2. **Pipeline board:** Kanban by stage (drag to move, permission-checked server-side, stage-change activity logged), plus list view. Stage settings: rename/reorder/add stages mapped to categories; deleting a stage requires moving its leads.
3. **Assignment:** manual, or round-robin per branch among Sales Staff (setting), reassignment logged.
4. **Follow-up tasks:** create from lead/member, due dates, "My tasks" view, overdue badge, reminders (in-app/email). System creates a "first contact" task for every new lead (configurable SLA, e.g. 15 min).
5. **Trials:** book a trial for a lead (free-slot or into a class session from M3 with capacity rules); trial check-in via manual check-in or a temporary trial pass QR; attended/no-show updates the lead stage category automatically.
6. **Conversion:** "Convert to member" pre-fills a member from the lead (D-04 identity rules), opens the sell-membership flow (M2/M4); on paid/activated membership the lead becomes WON with links to member + membership. Lost with required reason.
7. **Capture:** public hosted form per branch (`/l/{tenantSlug}/{formKey}`) and an embeddable snippet; honeypot + rate limit + optional captcha hook; consent checkbox text stored with the lead (D-12/§11 consent rules); UTM capture. Website enquiry **API** (`POST /api/public/v1/leads`) with tenant API keys (hashed, scoped, revocable), documented in `docs/API_DESIGN.md` (OpenAPI).
8. **Lead scoring (rule-based, transparent):** points for source, recency, trial booked/attended, responded; score breakdown visible; no "AI" label.
9. **Import/export:** CSV with dry-run validation (background job); export with permission and audit.
10. **Campaign attribution:** campaigns as tracking entities (channel, code, dates); first-touch and last-touch on lead; report: leads → trials → members → revenue by source/campaign (KPI definitions).
11. **Domain events:** emit `lead.created`, `lead.stage_changed`, `lead.uncontacted_sla_breached`, `trial.booked`, `trial.attended`, `lead.converted` through the outbox so M6 automations can subscribe without changing M5 code.
12. **Job hardening:** transactional outbox dispatcher, dead-letter view in admin System Health (inspect/retry), job metrics.

## Tests required
- Unit: duplicate matching, round-robin fairness, scoring rules, stage-category mapping, attribution (first/last touch).
- Integration: public form cannot target another tenant's branch; API key scoped to one tenant; conversion transaction links lead ↔ member ↔ membership atomically; outbox delivers each event exactly once to the handler (idempotent consumer).
- E2E: website form → lead appears with source/UTM → task assigned → trial booked → attended → converted → membership paid → campaign report shows 1 paid member.

## Out of scope
Sending WhatsApp/automated messages (M6), visual workflow builder.

## Acceptance checklist
- [ ] A lead can be traced from capture through trial to a paid membership, with source and campaign intact.
- [ ] Custom stages never break funnel reports.
- [ ] Public capture is abuse-resistant and tenant-safe.
- [ ] Outbox events emitted for every lead lifecycle step.
- [ ] All checks pass; API docs and status doc updated.
