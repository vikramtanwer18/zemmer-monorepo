-- M1: who can touch what, row-level security, the few functions that cross the realm boundary,
-- and default catalog data (features, plans, platform settings).
--
-- Roles (see 20261102054049_db_roles_and_rls_helpers):
--   gym_owner     owns everything; migrations and seeds. Table owner, so RLS does not apply to it.
--   gym_app       web + worker tenant jobs. Schema "app" with RLS; a narrow, RLS-filtered slice of "platform".
--   gym_platform  admin + worker platform jobs. Schema "platform" only; reaches tenant data solely
--                 through the SECURITY DEFINER functions in schema "platform_api" below.

-- ---------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------

-- The signed-in user for the current transaction, set by withUser() for queries that span the
-- user's own tenants (the tenant picker). NULL when unset.
CREATE OR REPLACE FUNCTION "app".current_user_id() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

REVOKE ALL ON FUNCTION "app".current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".current_user_id() TO gym_app;

-- ---------------------------------------------------------------------------------
-- RLS on tenant-owned tables in "app"
-- ---------------------------------------------------------------------------------

-- Standard policy: a row is visible and writable only inside withTenant() for its tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'role_assignment', 'branch', 'invitation', 'tenant_settings',
    'audit_log', 'outbox', 'idempotency_record'
  ]
  LOOP
    EXECUTE format('ALTER TABLE "app".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON "app".%I TO gym_app '
      'USING (tenant_id = "app".current_tenant_id()) '
      'WITH CHECK (tenant_id = "app".current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

-- Memberships: also readable by their own user without a tenant set, so the tenant picker can
-- list "my gyms". Writes still need the tenant.
ALTER TABLE "app".tenant_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_self_select ON "app".tenant_membership FOR SELECT TO gym_app
  USING (tenant_id = "app".current_tenant_id() OR user_id = "app".current_user_id());
CREATE POLICY tenant_insert ON "app".tenant_membership FOR INSERT TO gym_app
  WITH CHECK (tenant_id = "app".current_tenant_id());
CREATE POLICY tenant_update ON "app".tenant_membership FOR UPDATE TO gym_app
  USING (tenant_id = "app".current_tenant_id())
  WITH CHECK (tenant_id = "app".current_tenant_id());
CREATE POLICY tenant_delete ON "app".tenant_membership FOR DELETE TO gym_app
  USING (tenant_id = "app".current_tenant_id());

-- Audit logs are append-only for the application.
REVOKE UPDATE, DELETE ON "app".audit_log FROM gym_app;

-- ---------------------------------------------------------------------------------
-- gym_app's slice of "platform"
-- ---------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA "platform" TO gym_app;

-- Catalog data: read-only, not tenant specific.
GRANT SELECT ON "platform".feature, "platform".saas_plan, "platform".plan_feature,
  "platform".platform_setting TO gym_app;

-- Tenant row: created at self-signup, profile fields editable by the tenant's own staff.
GRANT SELECT, INSERT ON "platform".tenant TO gym_app;
GRANT UPDATE (display_name, legal_name, timezone, currency, locale, updated_at)
  ON "platform".tenant TO gym_app;
ALTER TABLE "platform".tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON "platform".tenant TO gym_platform USING (true) WITH CHECK (true);
CREATE POLICY app_select ON "platform".tenant FOR SELECT TO gym_app
  USING (
    id = "app".current_tenant_id()
    OR EXISTS (
      SELECT 1 FROM "app".tenant_membership m
      WHERE m.tenant_id = tenant.id AND m.user_id = "app".current_user_id()
    )
  );
CREATE POLICY app_insert ON "platform".tenant FOR INSERT TO gym_app
  WITH CHECK (id = "app".current_tenant_id());
CREATE POLICY app_update ON "platform".tenant FOR UPDATE TO gym_app
  USING (id = "app".current_tenant_id())
  WITH CHECK (id = "app".current_tenant_id());

-- Subscription: created at self-signup; every later change is made by the platform side.
GRANT SELECT, INSERT ON "platform".tenant_subscription TO gym_app;
-- Overrides and support sessions: read-only for the tenant (support sessions drive the in-app notice).
GRANT SELECT ON "platform".subscription_override, "platform".support_session TO gym_app;
-- Usage counters: maintained by the tenant's own transactions.
GRANT SELECT, INSERT, UPDATE ON "platform".usage_counter TO gym_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_subscription', 'subscription_override', 'support_session', 'usage_counter'
  ]
  LOOP
    EXECUTE format('ALTER TABLE "platform".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_all ON "platform".%I TO gym_platform USING (true) WITH CHECK (true)',
      t
    );
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON "platform".%I TO gym_app '
      'USING (tenant_id = "app".current_tenant_id()) '
      'WITH CHECK (tenant_id = "app".current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------
-- gym_app: invitation lookup by token
-- ---------------------------------------------------------------------------------

-- The invite link carries only a token, so the tenant is unknown until the token is looked up.
-- Returns just the ids; everything else is read afterwards inside withTenant().
CREATE OR REPLACE FUNCTION "app".find_invitation_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.tenant_id FROM "app".invitation i WHERE i.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION "app".find_invitation_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".find_invitation_by_token(text) TO gym_app;

-- ---------------------------------------------------------------------------------
-- platform_api: the only doors from the platform realm into tenant data (D-05)
-- ---------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "platform_api";
REVOKE ALL ON SCHEMA "platform_api" FROM PUBLIC;
GRANT USAGE ON SCHEMA "platform_api" TO gym_platform;

-- Owner invitation for a tenant the platform created. The owner accepts it in apps/web.
CREATE OR REPLACE FUNCTION "platform_api".create_owner_invitation(
  p_tenant_id uuid,
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_platform_user_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Revoke earlier pending owner invitations for the same tenant.
  UPDATE "app".invitation
     SET status = 'REVOKED', updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND status = 'PENDING'
     AND invited_by_platform_user_id IS NOT NULL;

  INSERT INTO "app".invitation (
    id, tenant_id, email, roles, token_hash, status, expires_at,
    invited_by_platform_user_id, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_tenant_id, lower(p_email),
    '[{"roleKey": "GYM_OWNER", "branchId": null}]'::jsonb,
    p_token_hash, 'PENDING', p_expires_at, p_platform_user_id, now(), now()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Writes to the tenant's own audit log, so owners see platform actions (support access,
-- suspension) in their log.
CREATE OR REPLACE FUNCTION "platform_api".record_tenant_audit(
  p_tenant_id uuid,
  p_platform_user_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_meta jsonb
) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO "app".audit_log (
    id, tenant_id, actor_type, actor_platform_user_id, action, entity_type, entity_id, meta, created_at
  ) VALUES (
    gen_random_uuid(), p_tenant_id, 'PLATFORM', p_platform_user_id, p_action, p_entity_type,
    p_entity_id, p_meta, now()
  )
$$;

-- Owner names and emails, so the operator can contact a tenant. No other personal data.
CREATE OR REPLACE FUNCTION "platform_api".tenant_owner_contacts(p_tenant_id uuid)
  RETURNS TABLE (name text, email text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT u.name, u.email
    FROM "app".role_assignment r
    JOIN "app".tenant_membership m ON m.id = r.membership_id AND m.tenant_id = r.tenant_id
    JOIN "app"."user" u ON u.id = m.user_id
   WHERE r.tenant_id = p_tenant_id
     AND r.role_key = 'GYM_OWNER'
     AND m.status = 'ACTIVE'
   ORDER BY u.email
$$;

-- Troubleshooting view for an active support session: settings and counts, no member records.
-- Refuses unless the session belongs to the caller, has not ended and has not expired.
CREATE OR REPLACE FUNCTION "platform_api".support_tenant_snapshot(
  p_support_session_id uuid,
  p_platform_user_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT s.tenant_id INTO v_tenant
    FROM "platform".support_session s
   WHERE s.id = p_support_session_id
     AND s.platform_user_id = p_platform_user_id
     AND s.ended_at IS NULL
     AND s.expires_at > now();

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'support session is not active' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'settings', (
      SELECT jsonb_build_object(
        'gstRegistered', gst_registered,
        'gstin', gstin,
        'stateCode', state_code,
        'pricesIncludeTax', prices_include_tax,
        'require2faForStaff', require_2fa_for_staff,
        'hasLogo', logo_key IS NOT NULL
      )
      FROM "app".tenant_settings WHERE tenant_id = v_tenant
    ),
    'branches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', name, 'code', code, 'city', city, 'stateCode', state_code,
        'timezone', timezone, 'status', status
      ) ORDER BY created_at)
      FROM "app".branch WHERE tenant_id = v_tenant
    ), '[]'::jsonb),
    'activeMembershipsByRole', COALESCE((
      SELECT jsonb_object_agg(role_key, n)
        FROM (
          SELECT r.role_key, count(DISTINCT r.membership_id) AS n
            FROM "app".role_assignment r
            JOIN "app".tenant_membership m ON m.id = r.membership_id AND m.tenant_id = r.tenant_id
           WHERE r.tenant_id = v_tenant AND m.status = 'ACTIVE'
           GROUP BY r.role_key
        ) counts
    ), '{}'::jsonb),
    'pendingInvitations', (
      SELECT count(*) FROM "app".invitation
       WHERE tenant_id = v_tenant AND status = 'PENDING' AND expires_at > now()
    )
  );
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "platform_api" FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "platform_api" TO gym_platform;

-- ---------------------------------------------------------------------------------
-- Default catalog data. Editable in apps/admin; these are starting values, not demo data.
-- packages/core/src/entitlements/catalog.ts must list the same feature keys (tested).
-- ---------------------------------------------------------------------------------

INSERT INTO "platform".feature (key, type, module, description, default_value) VALUES
  ('branches.max',             'QUOTA',   'branches',   'Branches',                                 '1'),
  ('staff.max',                'QUOTA',   'staff',      'Active staff accounts (members excluded)', '3'),
  ('members.max',              'QUOTA',   'members',    'Active members',                           '100'),
  ('classes.enabled',          'BOOLEAN', 'classes',    'Classes and bookings',                     'false'),
  ('pt.enabled',               'BOOLEAN', 'trainers',   'Personal training packages',               'false'),
  ('crm.enabled',              'BOOLEAN', 'crm',        'Leads and CRM',                            'false'),
  ('online_payments.enabled',  'BOOLEAN', 'payments',   'Online payments (Razorpay)',               'false'),
  ('whatsapp.enabled',         'BOOLEAN', 'messaging',  'WhatsApp messaging',                       'false'),
  ('whatsapp.monthly_messages','QUOTA',   'messaging',  'WhatsApp messages per month',              '0'),
  ('automation.enabled',       'BOOLEAN', 'automation', 'Automation engine',                        'false'),
  ('workouts.enabled',         'BOOLEAN', 'fitness',    'Workout programs',                         'false'),
  ('nutrition.enabled',        'BOOLEAN', 'fitness',    'Nutrition tracking',                       'false'),
  ('rewards.enabled',          'BOOLEAN', 'engagement', 'Streaks, rewards and referrals',           'false'),
  ('reports.advanced',         'BOOLEAN', 'reports',    'Advanced reports and exports',             'false'),
  ('ai.copilot',               'BOOLEAN', 'ai',         'AI business copilot',                      'false'),
  ('ai.monthly_queries',       'QUOTA',   'ai',         'AI copilot questions per month',           '0'),
  ('expenses.enabled',         'BOOLEAN', 'finance',    'Expense tracking',                         'false'),
  ('pos.enabled',              'BOOLEAN', 'pos',        'Point of sale',                            'false'),
  ('inventory.enabled',        'BOOLEAN', 'pos',        'Inventory',                                'false'),
  ('audit.retention_days',     'CONFIG',  'audit',      'Audit log retention in days',              '365');

INSERT INTO "platform".saas_plan (id, code, version, name, description, status, currency, created_at, updated_at) VALUES
  (gen_random_uuid(), 'starter', 1, 'Starter', 'One branch, the essentials.',               'ACTIVE', 'INR', now(), now()),
  (gen_random_uuid(), 'growth',  1, 'Growth',  'Up to three branches, CRM and WhatsApp.',   'ACTIVE', 'INR', now(), now()),
  (gen_random_uuid(), 'pro',     1, 'Pro',     'Unlimited branches and every module.',      'ACTIVE', 'INR', now(), now());

-- null = unlimited for QUOTA features.
INSERT INTO "platform".plan_feature (plan_id, feature_key, value)
SELECT p.id, v.feature_key, v.value::jsonb
  FROM (VALUES
    ('starter', 'branches.max', '1'), ('starter', 'staff.max', '5'), ('starter', 'members.max', '300'),
    ('starter', 'classes.enabled', 'true'), ('starter', 'online_payments.enabled', 'true'),
    ('starter', 'expenses.enabled', 'true'), ('starter', 'audit.retention_days', '365'),

    ('growth', 'branches.max', '3'), ('growth', 'staff.max', '25'), ('growth', 'members.max', '2000'),
    ('growth', 'classes.enabled', 'true'), ('growth', 'pt.enabled', 'true'), ('growth', 'crm.enabled', 'true'),
    ('growth', 'online_payments.enabled', 'true'), ('growth', 'whatsapp.enabled', 'true'),
    ('growth', 'whatsapp.monthly_messages', '5000'), ('growth', 'automation.enabled', 'true'),
    ('growth', 'workouts.enabled', 'true'), ('growth', 'rewards.enabled', 'true'),
    ('growth', 'reports.advanced', 'true'), ('growth', 'expenses.enabled', 'true'),
    ('growth', 'audit.retention_days', '730'),

    ('pro', 'branches.max', 'null'), ('pro', 'staff.max', 'null'), ('pro', 'members.max', 'null'),
    ('pro', 'classes.enabled', 'true'), ('pro', 'pt.enabled', 'true'), ('pro', 'crm.enabled', 'true'),
    ('pro', 'online_payments.enabled', 'true'), ('pro', 'whatsapp.enabled', 'true'),
    ('pro', 'whatsapp.monthly_messages', '20000'), ('pro', 'automation.enabled', 'true'),
    ('pro', 'workouts.enabled', 'true'), ('pro', 'nutrition.enabled', 'true'),
    ('pro', 'rewards.enabled', 'true'), ('pro', 'reports.advanced', 'true'), ('pro', 'ai.copilot', 'true'),
    ('pro', 'ai.monthly_queries', '2000'), ('pro', 'expenses.enabled', 'true'), ('pro', 'pos.enabled', 'true'),
    ('pro', 'inventory.enabled', 'true'), ('pro', 'audit.retention_days', '1825')
  ) AS v(plan_code, feature_key, value)
  JOIN "platform".saas_plan p ON p.code = v.plan_code AND p.version = 1;

INSERT INTO "platform".platform_setting (key, value, updated_at) VALUES
  ('tenant.approval_required', 'false',       now()),
  ('trial.days',               '14',          now()),
  ('trial.plan_code',          '"starter"',   now()),
  ('trial.expired_status',     '"SUSPENDED"', now());
