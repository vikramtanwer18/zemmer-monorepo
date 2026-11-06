# MASTER SPEC: AI-Powered Gym Growth & Management SaaS Platform

> **How to use this file.** This is the full product specification. It is reference material, not a
> single prompt to execute end to end. Work is driven by one milestone prompt at a time from
> `docs/milestones/`. **`docs/DECISIONS.md` overrides this file wherever they conflict.** Notes marked
> `[AMENDED]` below record where a section was changed to match those decisions.


## 1. Your Role

Act as a Principal Software Architect, Senior Full-Stack Engineer, SaaS Product Manager, Database Architect, AI Engineer, DevOps Engineer, and QA Automation Engineer.

Your responsibility is to design, implement, test, and document a complete, production-oriented, multi-tenant Gym Growth & Management SaaS platform.

Do not create only a UI prototype, static dashboard, or collection of disconnected CRUD pages. Build a cohesive application in which the frontend, backend, database, authorization, business logic, background jobs, integrations, and reporting work together.

Work directly within the current repository using the available development tools. Inspect the existing codebase before making changes. Preserve working functionality and existing architectural decisions unless there is a clear reason to change them.

If the repository is empty, establish a clean, maintainable project structure.

Do not stop after producing a plan. Start implementing the application, verify each milestone, and continue until the available scope is implemented or a genuine blocker requires clarification.

---

# 2. Product Vision

Build an AI-powered Gym Growth & Management Platform that helps gym owners:

1. Manage everyday gym operations.
2. Acquire new members through lead generation and marketing.
3. Convert leads into paying members.
4. Manage memberships, payments, subscriptions, and renewals.
5. Control attendance through QR-code check-in.
6. Manage classes, trainers, staff, and workout programs.
7. Improve member engagement, consistency, and retention.
8. Recover overdue payments and revenue from expiring memberships.
9. Analyze profitability, sales performance, and business growth.
10. Automate repetitive tasks using workflows, messaging, and AI.
11. Operate multiple branches from one centralized system.
12. Provide members with a useful mobile-first experience.

The platform must connect operations, marketing, finance, and member engagement into one system.

## Core product positioning

"An AI-powered Gym Growth & Management Platform that helps gym owners manage operations, acquire members, recover revenue, and improve retention from one connected system."

Build the product around measurable business outcomes, not merely the number of available features.

---

# 3. Product Principles

Follow these principles throughout development:

- Multi-tenant isolation is mandatory.
- Every business operation must enforce authorization on the server.
- Business logic must not exist only in frontend components.
- Use real database-backed functionality rather than fake data in production features.
- Every important action must have loading, success, validation, and error states.
- Payments must be handled through verified provider events and idempotent processing.
- Messaging must respect customer consent and provider policies.
- AI must use authorized business data and must not invent financial figures.
- Sensitive operations must be auditable.
- External integrations must be replaceable through well-defined interfaces.
- Design reusable components and maintainable modules.
- Build accessible, responsive interfaces.
- Avoid premature microservices and unnecessary infrastructure complexity.
- Never claim a feature is implemented or tested when it is not.

Use sensible defaults when requirements are incomplete. Document assumptions and ask questions only when a decision materially affects security, architecture, or irreversible operations.

# 4. Technology Stack

Inspect the repository first and reuse compatible technologies where practical.

If starting from scratch, prefer the following stack.

## Application

- Next.js with App Router
- React and TypeScript
- Tailwind CSS
- Lucide React for icons
- Zod for runtime validation
- React Hook Form for complex forms
- TanStack Query for client-side server state where RSC is not enough `[AMENDED: D-02 — no Redux for server state]`
- Recharts for analytics visualizations

Do not introduce a large external UI component library unless the project already uses one or there is a compelling reason.

Create a consistent internal design system with reusable buttons, inputs, dialogs, tables, dropdowns, cards, badges, navigation, and feedback components.

## Backend

`[AMENDED: D-01]` The repository is a pnpm + Turborepo monorepo: `apps/admin`, `apps/web`, `apps/worker`, and shared `packages/*`. Business logic lives in `packages/core`.

Use:

- Route Handlers for HTTP APIs and webhooks
- Server Actions for appropriate application mutations
- Server-only service modules for business logic
- Repository/data-access modules where they improve separation
- Zod validation for external inputs
- Explicit authorization checks in every protected operation

Do not duplicate business logic across Server Actions, API routes, and UI components.

`[AMENDED: D-01]` A separate BullMQ worker (`apps/worker`) exists from M0. Python services are not planned.

## Database

- PostgreSQL
- Prisma ORM
- Versioned schema migrations
- Foreign keys and unique constraints
- Transactions for related financial and membership operations
- Appropriate indexes
- Explicit tenant-scoped queries
- Audit and event records for critical operations

Use UUIDs or another consistent identifier strategy. Store timestamps in UTC and render them using the tenant's configured timezone.

Use integer minor currency units where supported and appropriate, with explicit currency codes. Never rely on floating-point arithmetic for financial calculations.

## Infrastructure

Design for:

- Local development
- Production
- Managed PostgreSQL such as AWS RDS
- Redis for caching, queues, rate limiting, and distributed coordination where needed
- Durable background job processing
- Object storage for uploaded files
- Centralized logs and error monitoring
- Automated CI/CD
- Database backups and recovery
- Environment-specific configuration

`[AMENDED: D-06]` Deploy as Docker containers on AWS EC2 with RDS PostgreSQL, ElastiCache Redis, S3, and SES.

---

# 5. Multi-Tenant Architecture

Design the application for multiple independent gym businesses using the same SaaS platform.

Use a shared application and a tenant-aware data model initially, with PostgreSQL as the primary database.

## Tenant hierarchy

Model the following relationships:

Platform
- SaaS Super Admin
- Platform settings
- SaaS subscription plans
- Tenant onboarding
- Platform billing
- Feature entitlements
- Platform audit logs

Gym tenant
- Gym organization
- Branches
- Owners and administrators
- Staff and trainers
- Members
- Membership plans
- Membership records
- Payments and invoices
- Leads and campaigns
- Classes and bookings
- Workouts and nutrition plans
- Reports and settings

A member, staff user, or trainer may belong to a particular tenant and, where appropriate, one or more authorized branches.

Define how identity works across tenants. A global user identity may participate in multiple organizations, but permissions and membership records must remain scoped to the correct organization.

## Tenant isolation requirements

1. Establish tenant context from a validated authenticated session and authorized organization membership.
2. Never trust a tenant ID supplied by the client without verifying access.
3. Scope every tenant-owned read and write operation.
4. Enforce branch-level access where applicable.
5. Protect background jobs and webhook processing from cross-tenant data leakage.
6. Verify authorization for downloads, uploaded files, reports, and exports.
7. Use database constraints to prevent invalid cross-tenant relationships.
8. `[AMENDED: D-05]` PostgreSQL row-level security is **required** on all tenant-owned tables as a second layer.
9. Do not rely exclusively on frontend route guards.
10. Write automated tests attempting cross-tenant access and unauthorized record modification.

Use a central tenant-scoping strategy rather than relying on developers to remember ad hoc filters.

## SaaS billing versus gym billing

Keep these systems separate.

**Platform billing:** what a gym owner pays for using the SaaS.

**Gym billing:** what a gym's members pay for memberships, personal training, classes, or products.

They require separate records, permissions, reporting, webhook processing, and reconciliation.

---

# 6. Authentication, RBAC, and Permissions

Implement secure authentication using a maintained authentication library compatible with the selected stack.

Support appropriate features such as:

- Login and logout
- Registration and invitations
- Password recovery
- Email verification where configured
- Session management
- MFA via email OTP — mandatory for platform admins and gym owners/administrators, optional for others `[AMENDED: D-03]`
- Email/password for all users; Google sign-in for gym owners and staff `[AMENDED: D-03]`
- Account deactivation
- Secure session expiration
- Login rate limiting
- Audit logging for security-sensitive operations

Implement server-enforced role-based access control with permissions that can be extended as the product grows.

## Initial roles

Platform roles:
- SaaS Super Admin
- Platform Support

Tenant roles:
- Gym Owner
- Gym Administrator
- Branch Manager
- Receptionist
- Sales Staff
- Trainer
- Accountant
- Member

Do not assume every gym needs every role. `[AMENDED: D-07]` v1 uses fixed roles with a code-defined permission matrix; tenant-configurable custom roles come later.

Create a permission matrix covering:

- View
- Create
- Edit
- Delete
- Approve
- Refund
- Export
- Manage settings
- Manage users
- Manage financial operations

Add ownership, tenant, and branch checks where applicable.

A receptionist must not automatically receive access to financial configuration. A trainer should not automatically access all payment records. A gym administrator must never access platform-wide SaaS administration.

---

# 7. Required Application Experiences

Build three main application experiences.

## A. SaaS Super Admin

`[AMENDED: D-03/D-05]` A separate app (`apps/admin`) with its own auth realm, cookies, and database role.

Features:

1. Platform overview and KPIs
2. Tenant directory
3. Tenant onboarding and approval, if required
4. Tenant details and operational status
5. SaaS subscription plans
6. Subscription and billing management
7. Feature entitlements and plan limits
8. Trial periods and subscription lifecycle
9. Platform payment records
10. Platform-level usage analytics
11. Support tools and tenant diagnostics
12. Global integration configuration
13. Platform audit logs
14. System health and background job status
15. Platform-wide announcement management

Never expose tenant business records to platform support by default. Any authorized support access must be limited, justified, and auditable.

## B. Gym Owner and Staff Dashboard

Create a tenant-aware dashboard with navigation based on permissions.

Required modules:

1. Dashboard
2. Member Management
3. Membership and Subscription Management
4. Attendance and QR Access Control
5. Classes, Schedules, and Bookings
6. Trainers and Staff Management
7. Personal Training and Fitness Programs
8. Payments, Billing, and Financial Management
9. Leads, CRM, and Marketing
10. Reports and Analytics
11. Branch Management
12. Inventory and Point of Sale, where enabled
13. Expenses and Profitability
14. Automation and Notifications
15. AI Business Copilot
16. Settings and Platform Configuration

Implement the modules described below.

## C. Gym Member Mobile Experience

Start with a polished, responsive, installable PWA unless a native mobile application already exists or a separate native app is explicitly required.

Structure the experience so it can later support React Native or another native mobile client through the same authenticated APIs and business services.

Members must see only their own authorized information.

Provide:

- Member home dashboard
- Digital membership card
- QR check-in
- Check-in history and streaks
- Membership status and renewal date
- Outstanding dues
- Payment checkout and receipts
- Workout plans and exercise tracking
- Nutrition and diet plans
- Fitness goals and progress
- Class booking and cancellation
- Trainer assignments and feedback
- Notifications and announcements
- Referral and rewards
- Profile and preferences
- Consent and privacy settings

---

# 8. Module Specifications

## Module 1: Dashboard

Create a business dashboard containing:

- Total members
- Active memberships
- New members
- Membership expiries
- Renewals
- Attendance trends
- Revenue collected
- Outstanding payments
- Lead pipeline
- Lead-to-member conversion
- Trial bookings
- Class occupancy
- Trainer utilization
- Branch comparisons
- Members potentially at risk of churn
- Recent activity

Provide configurable date ranges and branch filters.

Every KPI must have a documented definition and a consistent calculation. Distinguish booked revenue, collected payments, refunds, outstanding dues, and estimated profitability.

Make cards and charts navigable to the corresponding filtered records.

Do not use fabricated values outside clearly labeled demo or seed environments.

## Module 2: Member Management

Implement:

- Member creation and onboarding
- Search, filtering, sorting, and pagination
- Member profiles
- Contact and emergency information
- Membership history
- Attendance history
- Payment and invoice history
- Assigned trainers
- Workout and nutrition plans
- Fitness assessments
- Goals and progress measurements
- Member notes
- Consent records
- Document uploads
- Member status
- Import and export
- Bulk operations with appropriate confirmation

Define member lifecycle states and transitions.

Prevent duplicate submissions and invalid state changes. Apply data-retention and deletion policies appropriate to legal obligations and business requirements.

## Module 3: Membership Management

Support configurable plans with:

- Name and description
- Duration
- Price and currency
- Joining fees
- Taxes where applicable
- Access rules
- Branch eligibility
- Class or training entitlements
- Trial periods
- Discounts and coupons
- Renewal policies
- Freeze or pause rules
- Grace periods
- Cancellation policies
- Upgrade and downgrade rules
- Recurring billing where supported

Implement membership records with explicit states such as pending, active, paused, expired, and cancelled, adjusting the state model to the actual business rules.

Prevent duplicate active memberships when the selected plan or business rules prohibit them.

Handle renewals, payment failures, extensions, refunds, and membership expiry through well-defined services.

## Module 4: QR Attendance and Access Control

Implement secure QR-based check-in.

`[AMENDED: D-09]` The member shows a rotating QR on their digital card in the PWA; authorized staff scan
it from the staff dashboard. The code is TOTP-style (opaque pass id + time step + HMAC), works offline, and
each code is accepted once. Staff can also check members in manually with a reason.

Requirements:

- Generate a digital membership pass
- Use signed or opaque, unguessable tokens
- Verify the member's identity and membership eligibility on the server
- Support branch-specific access rules
- Enforce check-in and check-out rules
- Prevent duplicate scans and replay attacks
- Record attendance events
- Support authorized manual corrections
- Record the staff member or device responsible for manual changes
- Maintain attendance history
- Display clear error states for expired, invalid, or unauthorized passes

Never put personal information, authentication credentials, or sensitive member data directly into a QR code.

Do not rely on a static QR code alone for high-security physical access. Design integration points for time-limited QR tokens and compatible access-control hardware.

## Module 5: Classes and Booking

Implement:

- Class categories
- Class and session creation
- Recurring schedules
- Trainer assignment
- Room or location assignment
- Capacity limits
- Eligible membership rules
- Booking and cancellation
- Waitlists
- Attendance marking
- No-show tracking
- Booking reminders
- Calendar views
- Conflict detection
- Booking history

Use transactions or other concurrency-safe mechanisms to prevent overbooking when multiple members book the last available slot simultaneously.

## Module 6: Trainers and Staff

Implement:

- Staff invitations
- Staff profiles
- Roles and permissions
- Branch assignments
- Trainer specialties
- Working schedules
- Availability
- Client assignments
- Personal training appointments
- Session packages
- Session completion
- Trainer notes
- Trainer performance reporting
- Staff activity logs

Enforce permission restrictions for staff management and compensation information.

## Module 7: Workout and Fitness Programs

Implement:

- Exercise library
- Exercise instructions and media references
- Workout plan creation
- Plan templates
- Sets, reps, weights, and duration
- Rest intervals
- Weekly training schedules
- Trainer assignments
- Workout completion tracking
- Personal records
- Fitness assessments
- Progress charts
- Body measurements
- Member goals
- Trainer feedback

AI-generated plans must be reviewed or approved by a qualified trainer when appropriate. Do not make unsupported medical claims or treat general fitness recommendations as medical advice.

## Module 8: Nutrition and Calorie Tracking

Implement:

- Trainer-assigned diet plans
- Meal schedules
- Food logs
- Calorie estimates
- Protein, carbohydrates, and fat tracking
- Water intake
- Nutrition goals
- Weekly progress summaries

Store the source and assumptions for nutritional estimates where possible. Clearly communicate uncertainty. Allow members to correct logged information.

Treat health and fitness data as sensitive information and enforce strict access controls, consent, retention, and deletion policies.

## Module 9: Payments and Financial Management

Design a provider-independent payment architecture.

`[AMENDED: D-10/D-11]` v1 ships Razorpay only, behind an adapter. Each gym connects **its own** Razorpay
account. Members can buy, renew, and pay balances from the PWA; staff can send payment links and record
manual payments (cash, UPI, bank transfer, etc.). Partial payments are allocated to invoices; overpayment
becomes member credit. GST-registered and unregistered gyms are both supported.

Support appropriate providers through replaceable adapters, with initial provider choices determined by business requirements and deployment region.

Potential providers include Razorpay, Stripe, and other compatible providers.

Implement:

- Payment records
- Checkout sessions
- Online and manual payments
- Cash and bank-transfer recording
- Payment statuses
- Partial payments if supported
- Outstanding balances
- Invoices and receipts
- Discounts and tax calculations
- Refund workflows
- Failed-payment handling
- Reconciliation
- Revenue reports
- Expenses
- Financial exports
- Trainer commissions where configured

Never store raw card details.

Verify webhook signatures. Make webhook processing idempotent. Handle retries and out-of-order events safely. Use transactions to keep payment, invoice, and membership records consistent.

A browser redirect is not proof of successful payment. Use verified provider events and reconciliation.

Implement SaaS subscription billing independently from gym-member billing.

## Module 10: Leads and CRM

Implement a full lead-management workflow:

- Lead capture forms
- Manual lead entry
- Lead sources
- Website enquiry integration
- Trial requests
- Lead assignment
- Sales pipeline
- Lead stages
- Lead scoring
- Follow-up tasks
- Call and interaction history
- Sales notes
- Reminders
- Trial attendance
- Conversion to membership
- Lost-lead reasons
- Lead import and export
- Campaign attribution

Create a configurable pipeline, for example:

New → Contacted → Trial Scheduled → Trial Attended → Offer Sent → Converted / Lost.

Allow authorized administrators to customize stages without breaking reporting.

Maintain a traceable relationship between the original lead, its campaign, trial booking, member record, and resulting membership.

## Module 11: WhatsApp and Marketing Automation

Integrate the official WhatsApp Business Platform using supported APIs and onboarding flows.

`[AMENDED: D-12]` Tenant-owned WABAs. Build Manual Connect first; add Meta Embedded Signup once the
operator is an approved Meta Tech Provider.

Design the integration for multiple tenants.

Each gym should be able to connect its own authorized business assets when using the customer-owned account model.

Implement:

- WhatsApp account onboarding
- Phone-number and business-account configuration
- Template synchronization
- Template status tracking
- Contact opt-in records
- Opt-out and suppression lists
- Audience segmentation
- Campaign creation
- Template variable mapping
- Campaign scheduling
- Delivery-status tracking
- Incoming-message webhook processing
- Lead follow-up automation
- Trial reminders
- Membership expiry reminders
- Payment reminders
- Win-back campaigns
- Campaign analytics
- Conversion attribution
- Retry and failure management

Respect messaging windows, approved-template requirements, rate limits, quality restrictions, and current Meta policies.

Do not use unofficial WhatsApp automation, browser scraping, or personal WhatsApp sessions to send bulk messages.

Never send promotional messages without appropriate consent. Record when and how consent was collected. Make opt-outs effective across future campaigns.

Keep provider credentials encrypted and server-side. Never expose access tokens to the browser.

If WhatsApp onboarding requires external Meta approval or credentials, implement the integration interface, configuration states, and clear setup instructions rather than pretending it is connected.

## Module 12: Automation Engine

Build a reusable event-driven workflow system.

Example triggers:

- New lead created
- Lead not contacted within a configured period
- Trial booked
- Trial attended
- Membership purchased
- Membership approaching expiry
- Payment failed
- Payment overdue
- Member attendance drops below a threshold
- Class booking cancelled
- Referral converted

Example actions:

- Create a follow-up task
- Assign a staff member
- Schedule an eligible message
- Send an in-app notification
- Create an owner alert
- Update a supported status
- Generate a report
- Request human approval

Each workflow should define:

- Tenant ownership
- Trigger
- Conditions
- Actions
- Scheduling rules
- Retry behavior
- Failure handling
- Execution history
- Enable/disable status

Prevent duplicate execution using idempotency keys and durable job processing.

Do not allow arbitrary untrusted code execution through user-configured workflows.

Start with predefined triggers and actions. Introduce a visual workflow builder only after the underlying engine is reliable.

## Module 13: Retention and Revenue Recovery

Create a retention dashboard that identifies members needing attention.

Initial signals can include:

- Declining attendance
- Extended absence
- Upcoming membership expiry
- Overdue payments
- Failed renewals
- Unused class entitlements
- Inactive leads
- Unanswered trial follow-ups

Allow gyms to configure thresholds appropriate to their operations.

Provide a recommended next action, such as a staff call, renewal offer, or permitted WhatsApp follow-up.

Begin with transparent, rules-based indicators. Later, introduce predictive churn scoring using sufficient, reliable historical data.

Do not present heuristic scores as validated AI predictions.

Measure outcomes, including successful renewals, recovered payments, lead conversions, and member reactivation.

## Module 14: Reports and Business Intelligence

Implement:

- Membership reports
- Renewal reports
- Attendance reports
- Revenue collected
- Outstanding dues
- Refunds
- Lead conversion
- Campaign performance
- Trial conversion
- Member retention
- Churn and inactivity indicators
- Class utilization
- Trainer utilization
- Branch comparisons
- Expenses and profitability
- Referral performance
- Inventory reports when enabled

Define financial and operational metrics precisely.

For example:

- Collection rate must have an explicit numerator, denominator, and time period.
- Lead conversion must identify which leads and conversions are included.
- Revenue must distinguish collected cash from invoices issued.
- Estimated lifetime value must be labeled as an estimate.
- Profitability must disclose which expenses are included.

Support date filters, branch filters, export permissions, and pagination.

Large reports should use background jobs where appropriate.

## Module 15: AI Gym Business Copilot

Build an AI assistant integrated with authorized tenant data.

Example questions:

- Why did membership revenue change this month?
- Which leads require follow-up today?
- Which members have a renewal coming up?
- Which campaigns produced the most paid memberships?
- Which branches have declining attendance?
- What payments require reconciliation?
- Summarize this week's business performance.

Architecture:

1. Authenticate the user.
2. Resolve the authorized tenant and branch scope.
3. Identify the permitted business-data sources.
4. Generate a constrained query or invoke approved business tools.
5. Validate tool arguments and enforce authorization.
6. Execute queries through controlled services.
7. Calculate metrics using deterministic business logic.
8. Provide a concise explanation with the reporting period and data source.
9. Log relevant actions and failures without unnecessarily storing sensitive content.

Use structured outputs and server-defined tools. Never expose unrestricted database access, arbitrary SQL execution, environment variables, secrets, or cross-tenant data to an LLM.

AI responses must distinguish facts from estimates and disclose when data is insufficient.

Start with read-only analytics and recommendations.

Any action involving refunds, payments, customer messaging, membership cancellation, or other consequential changes must require the appropriate authorization and, where applicable, explicit confirmation.

Use a provider abstraction so the LLM can be changed without rewriting the business layer. `[AMENDED: D-13]` Use the OpenAI-compatible SDK; the platform admin configures provider base URL, model, and key.

## Module 16: Member Engagement and Rewards

Implement:

- Attendance streaks
- Workout completion milestones
- Personal records
- Goals and achievements
- Referral tracking
- Configurable reward rules
- Reward redemption
- Member challenges
- Trainer feedback
- Member announcements
- Optional leaderboards

Define how streaks are calculated and what happens when a member's membership is paused or expired.

Avoid rewarding unsafe overtraining or encouraging unhealthy exercise behavior.

## Module 17: Branch Management

Implement:

- Branch creation
- Branch settings
- Staff assignments
- Branch-level permissions
- Membership access rules
- Attendance records
- Class schedules
- Financial reports
- Branch-specific branding where supported
- Consolidated owner dashboards
- Member transfers between branches

Use explicit authorization rules for cross-branch access.

## Module 18: Expenses, Inventory, and POS

Create extensible modules for:

- Expense categories
- Expense records
- Suppliers
- Product catalog
- Stock levels
- Stock movements
- Purchase records
- Point-of-sale transactions
- Inventory adjustments
- Low-stock alerts

These features should be tenant- and branch-scoped. Keep inventory accounting distinct from membership revenue.

## Module 19: Notifications

Support:

- In-app notifications
- Email notifications
- Push notifications where supported
- WhatsApp through the official integration
- Notification preferences
- Delivery status
- Retry handling
- Scheduled reminders
- Template management

Separate essential service notifications from promotional marketing.

Honor communication preferences, applicable consent requirements, and unsubscribe rules.

## Module 20: Settings

Implement:

- Organization profile
- Branch settings
- Timezone and locale
- Currency
- Tax settings
- Invoice numbering
- Membership policies
- Cancellation rules
- Branding
- Roles and permissions
- Payment provider configuration
- WhatsApp configuration
- Email configuration
- Notification preferences
- Data export
- Audit logs
- Retention and privacy settings
- Integration status

Never display stored credentials or API secrets in plaintext.

---

# 9. Database Design Requirements

Design a normalized and maintainable PostgreSQL schema.

Consider entities including:

Platform:
- User
- Tenant
- TenantMembership
- Role
- Permission
- RolePermission
- Branch
- TenantSubscription
- PlatformInvoice
- PlatformPayment
- FeatureEntitlement
- AuditLog

Gym operations:
- MemberProfile
- StaffProfile
- TrainerProfile
- MembershipPlan
- Membership
- MembershipEvent
- AttendanceEvent
- Class
- ClassSession
- Booking
- WaitlistEntry
- Exercise
- WorkoutPlan
- WorkoutAssignment
- WorkoutLog
- NutritionPlan
- NutritionLog
- FitnessAssessment

CRM and messaging:
- Lead
- LeadActivity
- LeadStage
- TrialBooking
- Campaign
- CampaignRecipient
- MessageTemplate
- WhatsAppAccount
- ContactConsent
- SuppressionRecord
- MessageEvent
- AutomationWorkflow
- AutomationExecution
- FollowUpTask

Financial:
- GymInvoice
- GymPayment
- PaymentAllocation
- Refund
- Expense
- ExpenseCategory
- Product
- InventoryMovement
- POSOrder

Platform services:
- Notification
- NotificationPreference
- FileRecord
- IntegrationConfiguration
- WebhookEvent
- BackgroundJobRecord
- IdempotencyRecord
- AuditLog

Treat this list as a starting point, not a requirement to create every table immediately.

For each entity, determine:

- Tenant and branch ownership
- Required fields
- Foreign keys
- Unique constraints
- Indexes
- Status transitions
- Soft-deletion requirements
- Retention requirements
- Audit requirements

Avoid storing duplicate derived data unless there is a justified performance or audit requirement.

Use transactions for critical multi-record operations.

Document the entity relationships and provide a Mermaid ER diagram.

Generate versioned Prisma migrations. Never reset or drop a database containing real data as a shortcut to resolve migration problems.

---

# 10. API and Business Service Design

Use consistent service boundaries.

Suggested domains:

- Authentication and authorization
- Tenant management
- Membership management
- Attendance
- Scheduling and bookings
- CRM and leads
- Billing and payments
- Marketing and messaging
- Automations
- Reports and analytics
- AI assistant
- Notifications
- Files
- Platform administration

For each endpoint or server action:

1. Validate input.
2. Authenticate the user.
3. Authorize the operation.
4. Establish the tenant and branch scope.
5. Execute business rules.
6. Use transactions where required.
7. Return a consistent response.
8. Log relevant operational information.
9. Handle expected errors.
10. Prevent duplicate processing where applicable.

Use stable error codes and appropriate HTTP status codes.

Protect sensitive endpoints with rate limiting and abuse controls.

Generate API documentation for public or integration-facing APIs.

Do not expose internal service credentials or database details in responses.

---

# 11. Frontend and Design System

Create a polished, professional SaaS interface suitable for desktop, tablet, and mobile.

## Visual direction

Use a clean, modern fitness-business aesthetic.

Suggested palette:
- Primary: #204289
- Secondary: #394E85
- Accent: #00A89D
- Background: #F7F7F7

Use accessible color contrast and consistent semantic colors for success, warnings, errors, and neutral states.

Use Lucide icons and a reusable internal component system.

Build:

- Responsive sidebar
- Header with tenant and branch switchers
- Search
- Breadcrumbs
- Notification center
- Profile menu
- Reusable data tables
- Filters and pagination
- Form validation
- Confirmation dialogs
- Empty states
- Loading skeletons
- Error boundaries
- Accessible navigation
- Responsive charts
- Mobile-friendly forms and actions

Do not fill every screen with cards. Prioritize hierarchy, readability, task completion, and useful information density.

Implement realistic seeded data only in development and demo environments.

Every visible button and navigation item must have a meaningful action or be clearly marked as unavailable.

---

# 12. Background Jobs and Reliability

Use a durable queue for tasks that should not depend on a browser request remaining open.

Examples:

- Scheduled WhatsApp campaigns
- Membership expiry reminders
- Payment reconciliation
- Email delivery
- Report generation
- Notification delivery
- Workflow execution
- Data imports and exports
- AI processing when it is expensive or asynchronous

Use Redis and a suitable queue library if compatible with the chosen architecture.

Implement:

- Retries with backoff
- Idempotency
- Job status tracking
- Dead-letter handling or equivalent failure recovery
- Timeouts
- Rate limiting
- Structured logging
- Tenant context propagation
- Graceful worker shutdown

Do not silently discard failed jobs.

For financial and messaging jobs, prevent duplicate external side effects wherever the provider supports idempotency.

Use a transactional outbox pattern where it is justified to reliably coordinate database changes with background processing.

---

# 13. Security and Privacy

Apply secure development practices throughout the project.

Required protections:

- Server-side authentication and authorization
- Tenant isolation
- Branch-level access control
- Input validation
- Output encoding
- Protection against SQL injection and XSS
- CSRF protections where applicable
- Secure cookie settings
- Rate limiting
- Secure file uploads
- Secret management
- Webhook signature verification
- Payment idempotency
- Audit logging
- Sensitive-data minimization
- Data export and deletion workflows
- Appropriate backup and recovery controls
- Dependency and vulnerability checks

Do not store passwords in plaintext.

Do not log passwords, access tokens, payment credentials, or unnecessary personal or health information.

Implement data-retention and deletion policies that account for legitimate financial recordkeeping obligations and other applicable legal requirements.

Use least-privilege permissions for application users, database roles, integrations, and workers.

---

# 14. Testing Requirements

Use a testing strategy appropriate to the selected stack.

Suggested tools:
- Vitest or the repository's existing unit-test framework
- React Testing Library
- Playwright for browser-based end-to-end testing
- Integration tests against PostgreSQL
- Testcontainers when supported and appropriate

## Unit tests

Cover:

- Membership eligibility
- Renewal calculations
- Payment allocations
- Discounts and taxes
- QR token validation
- Booking capacity
- Role permissions
- Lead conversion
- Retention indicators
- Campaign eligibility
- Automation conditions
- Financial KPI calculations

## Integration tests

Cover:

- Database transactions
- Tenant-scoped queries
- Webhook handling
- Payment state transitions
- Job retries
- Message delivery status
- File access controls
- Authorization rules

## End-to-end tests

Test complete workflows:

1. Tenant onboarding.
2. Gym owner login.
3. Branch creation.
4. Membership plan creation.
5. Member registration.
6. Membership purchase.
7. Payment confirmation through a simulated provider.
8. QR check-in.
9. Class booking.
10. Trainer workout assignment.
11. Lead creation and conversion.
12. WhatsApp campaign setup in a mocked or sandbox integration.
13. Renewal reminders.
14. Financial reporting.
15. SaaS subscription management.

## Security tests

Explicitly test that:

- Tenant A cannot access Tenant B's data.
- Staff cannot access unauthorized modules.
- Members cannot access another member's profile.
- Unauthorized users cannot trigger refunds or membership cancellation.
- A forged payment webhook cannot mark an invoice as paid.
- Duplicate webhook delivery does not duplicate financial records.
- A replayed QR token cannot bypass the configured check-in rules.
- An AI assistant cannot retrieve unauthorized tenant data.
- A background job cannot execute under the wrong tenant context.

Never use real customer payments or send real marketing campaigns during automated tests.

---

# 15. Development Workflow

Follow this workflow.

## Step 1: Repository reconnaissance

Before editing files:

- Inspect the project structure.
- Inspect package.json and lockfiles.
- Identify framework and dependency versions.
- Inspect database configuration and Prisma schema.
- Review authentication and authorization.
- Review existing UI components and styles.
- Identify implemented features and unfinished work.
- Check existing tests and CI/CD.
- Identify deployment assumptions.
- Look for security risks and broken dependencies.

Do not overwrite working code or replace the existing project with a fresh scaffold without justification.

## Step 2: Establish the baseline

- Install dependencies using the existing package manager.
- Run existing lint, type-check, test, and build commands.
- Record existing failures.
- Identify missing environment variables.
- Verify database connectivity where safe.
- Document the current architecture.

Do not claim a pre-existing failure was caused by your changes without evidence.

## Step 3: Create the implementation plan

Create:

- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/DATABASE_DESIGN.md`
- `docs/SECURITY.md`
- `docs/API_DESIGN.md`
- `docs/ROADMAP.md`
- `docs/IMPLEMENTATION_STATUS.md`

Adapt paths if the repository already has an established documentation structure.

Define dependencies, milestones, acceptance criteria, and known risks.

## Step 4: Implement the foundation

Prioritize:

1. Application structure and design system.
2. Database schema and migrations.
3. Authentication.
4. Tenant context and isolation.
5. Role and permission enforcement.
6. Audit logging.
7. Error handling and validation.
8. Test infrastructure.
9. Seed data for development.
10. CI checks.

Do not build many business modules on an insecure foundation.

## Step 5: Implement vertical slices

Implement complete end-to-end features rather than creating all frontend pages first.

For example:

Membership management should include its UI, validated API, database schema, authorization, business rules, audit events, and tests.

QR attendance should include token generation, server validation, access checks, attendance persistence, duplicate prevention, and tests.

Payment processing should include checkout initiation, verified webhooks, transaction consistency, reconciliation, and tests.

## Step 6: Verify every milestone

After each milestone:

- Run lint.
- Run type checking.
- Run unit tests.
- Run integration tests where applicable.
- Run relevant end-to-end tests.
- Run the production build.
- Inspect the browser experience.
- Fix regressions before proceeding.
- Update the implementation status document.

If an external integration cannot be configured, use a documented mock or sandbox adapter and clearly identify what remains unconnected.

## Step 7: Continue implementation

Do not stop after creating documentation or a dashboard.

Complete the core workflows, then continue through the remaining prioritized modules.

Keep a list of unfinished requirements and revisit it after each milestone.

---

# 16. Delivery Milestones `[AMENDED: D-14]`

The milestone plan in this section was replaced. The authoritative plan is the set of prompts in
`docs/milestones/` (M0–M9), summarized in `docs/milestones/README.md`. M4 is the sellable MVP.

---

# 17. Environment and Configuration

Create a documented `.env.example` containing placeholder values for all required settings.

Potential variables include:

- `DATABASE_URL`
- `DIRECT_URL` if required by the database tooling
- Authentication secrets
- Application URL
- Redis connection
- Object storage configuration
- Email provider configuration
- Payment provider configuration
- WhatsApp Business Platform configuration
- Webhook verification secrets
- AI provider credentials
- Observability configuration

Use the actual environment variable names required by the selected libraries.

Never write real secrets to source control, test fixtures, documentation, client-side bundles, or logs.

Provide setup instructions covering local development, migrations, seed data, tests, and production deployment.

Do not invent credentials or assume third-party approvals have been granted.

---

# 18. Definition of Done

A feature is complete only when the relevant requirements are satisfied.

- The user interface works.
- Inputs are validated.
- Authentication is enforced.
- Permissions are enforced on the server.
- Tenant and branch isolation are verified.
- Data persists correctly.
- Business rules are implemented.
- Errors are handled clearly.
- Audit requirements are met.
- Automated tests cover important paths.
- Documentation is updated.
- The production build passes where the environment permits.
- External dependencies and limitations are documented.

A placeholder screen is not a completed feature.

A mocked integration is not a live integration.

A successful build does not prove business logic is correct.

Do not mark incomplete work as completed to make the progress report appear better.

---

# 19. How to Work Autonomously

Work in a structured, incremental manner.

You should:

1. Inspect before editing.
2. Create a plan.
3. Implement the highest-priority complete vertical slice.
4. Test it.
5. Fix issues.
6. Update documentation.
7. Move to the next slice.

Make routine technical decisions independently when they are reversible and consistent with the architecture.

Ask for approval before:

- Destructive database changes
- Removing existing functionality
- Sending real customer communications
- Making real financial transactions
- Deploying to production
- Changing security-sensitive settings
- Accessing or modifying production customer data

Do not ask me to manually perform steps that you can safely complete within the authorized development environment.

If credentials, external approvals, or infrastructure access are missing, continue with the portions that can be implemented and document the exact blocker.

---

# 20. Final Instructions `[AMENDED]`

Do not execute this file as one prompt. Each session runs one milestone prompt from `docs/milestones/`.
Maintain `docs/IMPLEMENTATION_STATUS.md` with completed, partial, and pending features; tests executed;
build status; known issues; integrations awaiting credentials or approval; and next tasks — all backed by
actual repository evidence.

The ultimate objective is a secure, maintainable, production-oriented, multi-tenant Gym SaaS platform that
connects gym operations, member engagement, lead generation, WhatsApp marketing, payments, revenue recovery,
retention automation, and AI business intelligence. Build it incrementally, verify it continuously, and never
sacrifice correctness or tenant isolation for speed.
