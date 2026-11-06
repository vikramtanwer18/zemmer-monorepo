# M1 — SaaS Core: Identity, Tenancy, RBAC, Entitlements, Platform Admin

**Goal:** a gym owner can sign up (or be invited by the platform), get a trial tenant with a first branch, sign in
with email/password or Google plus email OTP, invite staff with fixed roles, and switch tenant/branch — while every
query is tenant-scoped in code **and** by RLS. The platform admin can manage tenants, plans, and features in a
separate app and realm.

Follow the session protocol in `docs/milestones/README.md`.

## Read
- `docs/DECISIONS.md` D-01, D-03, D-04, D-05, D-07, D-15
- `MASTER_SPEC.md` §5 Multi-Tenant Architecture, §6 Auth & RBAC, §7A SaaS Super Admin, Module 17 Branch Management (create/settings/staff assignment only), Module 20 Settings (org profile, branch, timezone, locale, currency, tax identity fields), §9 (platform entities), §10, §13

## Data model (confirm before migrating)
`platform` schema: `PlatformUser`, platform auth tables (session, verification/OTP), `Tenant` (slug, legalName, displayName, status, country, timezone, currency, createdAt), `Feature` (key, type BOOLEAN|QUOTA|CONFIG, description), `SaasPlan` (+ versioning: plan code + version), `PlanFeature` (value per plan), `TenantSubscription` (status, planId, trialEndsAt, currentPeriodEnd — billing fields filled in M4), `SubscriptionOverride`, `UsageCounter`, `PlatformAuditLog`, `PlatformSetting`, `SupportSession`.

`app` schema: tenant-realm auth tables (`User`, `Session`, `Account` for Google, `Verification`/OTP), `TenantMembership` (userId, tenantId, status), `RoleAssignment` (membershipId, roleKey, branchId nullable = all branches), `Branch` (tenantId, name, code, address, state code, timezone override, gstin nullable), `Invitation`, `TenantSettings` (gstRegistered, gstin, legal name, state, pricesIncludeTax, require2faForStaff, etc.), `AuditLog`, `Outbox`, `IdempotencyRecord`.

Every `app.*` table except global identity tables has `tenantId`, FK to `platform.Tenant` (or a mirrored tenant id with FK if cross-schema FKs complicate roles — decide and document), composite indexes starting with `tenantId`, RLS policy, and a registry entry in the scoping extension.

## Build (in this order)

### 1. Auth — tenant realm (`packages/auth`, `apps/web`)
- Better Auth (verify current version/API). Email + password with strong hashing, email verification, password reset, sign-out, session listing + revoke, account deactivation.
- **Google sign-in** for staff/owners (hidden if Google env vars are absent; never show a broken button).
- **Email OTP second factor** per D-03: mandatory for Gym Owner and Gym Administrator, tenant-configurable for other staff, optional for members. Trusted-device remember (30 days) is allowed for staff below admin only.
- Email sent through `packages/integrations/email` (SES adapter in prod, SMTP→Mailpit in dev, in-memory fake in tests). Simple branded templates.
- Rate limits (Redis): login, OTP send, OTP verify, reset, invite accept — per IP and per account. Lockout with clear messages.
- Tenant picker after sign-in when the user has more than one membership; selection stored in the session and re-verified on each request.

### 2. Auth — platform realm (`apps/admin`)
- Separate Better Auth instance: own tables, own secret, own cookie name, own domain. Email + password + **mandatory** email OTP. No self-signup; first Super Admin created by a CLI seed command that reads credentials from env/prompt (never hard-coded).

### 3. Context, isolation, permissions
- `getAuthContext()` for server actions/routes in web: session → user → active tenant membership → role assignments → permission set → allowed branch ids. Throws `AUTH_REQUIRED`/`FORBIDDEN`.
- Scoping extension wired for all tenant models; `withTenant` used by every core service call. A test enumerates Prisma models and fails if a tenant-owned model is missing from the registry.
- RLS policies for all `app` tenant tables, applied through migrations.
- **Permission matrix** in code (`packages/auth/permissions.ts`): permission keys per module (`members.view`, `members.create`, `billing.refund`, `settings.manage`, `staff.manage`, `reports.export`, …) mapped to the fixed roles of D-07, with branch-scoped vs tenant-wide flags. Generate `docs/PERMISSIONS.md` from code (script) so docs never drift.
- `requirePermission(ctx, key, { branchId? })` helper; UI navigation filtered by the same permission set (but never trusted).
- Proxy/middleware only redirects unauthenticated users and sends users without an active tenant to the picker.

### 4. Entitlements & subscription gate
- Feature catalog seeded with keys for every module (e.g. `members.max` QUOTA, `classes.enabled`, `whatsapp.enabled`, `ai.copilot`, `branches.max`, `staff.max`, `pos.enabled`).
- `checkEntitlement(tenantId, key)` and `checkQuota(tenantId, key, delta)` with Redis-cached plan resolution and invalidation on plan change.
- Subscription status gate: `TRIALING | ACTIVE | PAST_DUE | GRACE | SUSPENDED | CANCELLED`. In M1 only trial start/expiry is live (expiry job in worker); payment-driven transitions come in M4. Suspended tenants are read-only with a banner; data is never deleted on downgrade/suspension.

### 5. Tenant onboarding & branches
- **Owner self-signup** in `apps/web`: account → gym details (name, timezone, currency INR default, state) → first branch → trial starts. One transaction creates tenant, branch, membership, owner role, settings, subscription. Platform setting decides whether new tenants need admin approval (then status `PENDING_APPROVAL`, owner sees a waiting screen).
- **Platform-created tenant**: admin creates tenant and invites the owner by email.
- Branch CRUD (respect `branches.max` quota), branch settings (address, state, timezone override, optional own GSTIN), tenant + branch switcher in the AppShell header.

### 6. Staff invitations (basic)
- Invite by email with role(s) and branch scope; accept flow creates/links the global `User` (D-04); resend/revoke; deactivate member of staff. Full staff profiles come in M3.

### 7. Settings (basic)
- Organization profile, logo upload (S3 presigned, image type/size checks), timezone, locale, currency, tax identity (GST registered y/n, GSTIN with checksum validation, legal name, state, prices include tax y/n), security (require 2FA for staff).

### 8. Audit logging
- `audit.record(ctx, action, entity, entityId, before?, after?, meta)` — redacts sensitive fields, never blocks the business transaction on log formatting errors but **does** write inside the same transaction for financial/security actions.
- Audit log viewer (tenant: Owner/Admin only; platform: Super Admin) with filters.

### 9. Platform admin app (`apps/admin`)
- Sign-in, dashboard (tenant counts by status, trials ending soon), tenant directory (search/filter), tenant detail (profile, status, subscription, usage counters — **no tenant business records**), approve/suspend/reactivate tenant (with reason, audited), plan & feature management (create plan versions, set feature values, per-tenant overrides with expiry), platform settings (approval required, trial length), platform audit log.
- **Support session:** Platform Support requests access to a tenant with a reason and duration (max 2 h). Read-only by default. Logged in both audit logs; tenant owner sees an in-app notice. Implement the access path, not a full UI clone — enough to view tenant settings and member counts for troubleshooting.

### 10. Seed data (dev/demo only)
Two tenants ("Iron Temple Jaipur" with 2 branches, "Pulse Fitness Pune" with 1), users for every role, one user who is staff at tenant A and member at tenant B, one Super Admin. Guard: seed refuses to run when `NODE_ENV=production`.

## Tests required
- Unit: permission matrix (every role × key snapshot), entitlement/quota evaluation, GSTIN validation, OTP expiry/attempt limits.
- Integration: tenant A user cannot read/update/delete tenant B rows via services **and** via raw queries as `gym_app` (RLS); branch-scoped role cannot act on another branch; platform DB role cannot select from `app` business tables; suspended tenant cannot write; invitation acceptance links an existing global user.
- E2E: owner signup → OTP → trial dashboard; invite receptionist → accept → sees only permitted nav; admin approves tenant; admin cannot sign in to web and vice versa; Google button hidden without config.

## Out of scope
Members, plans, payments, SaaS billing charges (M4), custom roles (later).

## Acceptance checklist
- [ ] Authenticated users can access only their authorized tenant and branch data — proven by integration tests at both layers.
- [ ] 2FA rules of D-03 enforced; rate limits verified by tests.
- [ ] Platform and tenant realms fully separate (cookies, secrets, tables, DB roles).
- [ ] Entitlement (402) and permission (403) checks run in the documented order on a sample protected action.
- [ ] Trial expiry job moves tenant to the configured state and the UI reacts.
- [ ] `docs/PERMISSIONS.md` generated; `docs/DATABASE_DESIGN.md` started with a Mermaid ER diagram of M1 tables.
- [ ] All checks + e2e pass; status doc updated.
