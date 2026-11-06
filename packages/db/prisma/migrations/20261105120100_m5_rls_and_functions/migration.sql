-- M5: row-level security for the CRM tables, guards, the public capture/API lookups, and the
-- operator's dead-letter view of the outbox.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lead_stage', 'lead_source', 'lost_reason', 'campaign', 'lead', 'lead_activity',
    'follow_up_task', 'trial_booking', 'lead_capture_form', 'tenant_api_key', 'lead_saved_view',
    'lead_assignment_cursor', 'event_consumption'
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

-- A lead needs a way to reach them.
ALTER TABLE "app".lead ADD CONSTRAINT lead_contactable CHECK (phone IS NOT NULL OR email IS NOT NULL);
ALTER TABLE "app".lead ADD CONSTRAINT lead_status_dates CHECK (
  (status = 'WON') = (won_at IS NOT NULL) AND (status = 'LOST') = (lost_at IS NOT NULL)
);
ALTER TABLE "app".lead ADD CONSTRAINT lead_lost_has_reason CHECK (status <> 'LOST' OR lost_reason_id IS NOT NULL);
ALTER TABLE "app".trial_booking ADD CONSTRAINT trial_times CHECK (ends_at > starts_at);
ALTER TABLE "app".campaign ADD CONSTRAINT campaign_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);
ALTER TABLE "app".campaign ADD CONSTRAINT campaign_budget CHECK (budget_minor IS NULL OR budget_minor >= 0);
ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m5_ranges CHECK (
  lead_first_contact_minutes BETWEEN 1 AND 10080 AND task_reminder_minutes BETWEEN 0 AND 1440
);

-- One live trial per lead per class.
CREATE UNIQUE INDEX trial_booking_one_live_per_class
  ON "app".trial_booking (tenant_id, lead_id, class_session_id)
  WHERE class_session_id IS NOT NULL AND status IN ('BOOKED', 'ATTENDED');
-- Stage names are unique among live stages.
CREATE UNIQUE INDEX lead_stage_live_name
  ON "app".lead_stage (tenant_id, lower(name))
  WHERE archived_at IS NULL;

-- History is kept: the timeline and event receipts are append-only; leads, tasks, trials,
-- stages, campaigns, forms and keys are archived/closed, never deleted, by the app.
REVOKE UPDATE, DELETE ON "app".lead_activity, "app".event_consumption FROM gym_app;
REVOKE DELETE ON "app".lead, "app".follow_up_task, "app".trial_booking, "app".lead_stage,
  "app".lead_source, "app".lost_reason, "app".campaign, "app".lead_capture_form,
  "app".tenant_api_key FROM gym_app;

-- ---------------------------------------------------------------------------------
-- Public capture: /l/{tenantSlug}/{formKey} finds the form before any tenant is known. Returns
-- the form only when the slug matches its tenant, the tenant is active, has CRM on its plan is
-- checked by the service, and the form and branch are live. The branch always comes from the form.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app".capture_form_lookup(p_tenant_slug text, p_key text)
  RETURNS TABLE (tenant_id uuid, form_id uuid, branch_id uuid, tenant_name text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT f.tenant_id, f.id, f.branch_id, t.display_name
    FROM "app".lead_capture_form f
    JOIN "platform".tenant t ON t.id = f.tenant_id
    JOIN "app".branch b ON b.tenant_id = f.tenant_id AND b.id = f.branch_id
   WHERE f.key = p_key
     AND t.slug = p_tenant_slug
     AND t.status = 'ACTIVE'
     AND f.archived_at IS NULL
     AND b.status = 'ACTIVE'
$$;

-- API keys: looked up by their public prefix; the caller compares the secret hash in constant time.
CREATE OR REPLACE FUNCTION "app".api_key_lookup(p_prefix text)
  RETURNS TABLE (tenant_id uuid, key_id uuid, secret_hash text, scopes text[], branch_id uuid,
                 revoked boolean, tenant_active boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.tenant_id, k.id, k.secret_hash, k.scopes, k.branch_id, k.revoked_at IS NOT NULL,
         t.status = 'ACTIVE'
    FROM "app".tenant_api_key k
    JOIN "platform".tenant t ON t.id = k.tenant_id
   WHERE k.prefix = p_prefix
$$;

-- Trial pass QR (scanner): finds the trial before the scanning staff's tenant is compared.
CREATE OR REPLACE FUNCTION "app".trial_pass_lookup(p_code text)
  RETURNS TABLE (tenant_id uuid, trial_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT tb.tenant_id, tb.id FROM "app".trial_booking tb WHERE tb.pass_code = p_code
$$;

REVOKE ALL ON FUNCTION "app".capture_form_lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app".api_key_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app".trial_pass_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".capture_form_lookup(text, text) TO gym_app;
GRANT EXECUTE ON FUNCTION "app".api_key_lookup(text) TO gym_app;
GRANT EXECUTE ON FUNCTION "app".trial_pass_lookup(text) TO gym_app;

-- ---------------------------------------------------------------------------------
-- Operator dead-letter view (admin System health, gym_platform): outbox rows that gave up.
-- Metadata only (topic, attempts, error); payloads hold ids, never personal data, and are not
-- returned. Retry puts a row back in the queue.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "platform_api".outbox_dead_letters(p_limit int)
  RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, topic text, attempts int,
                 last_error text, created_at timestamp)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.id, o.tenant_id, t.display_name, o.topic, o.attempts, o.last_error, o.created_at
    FROM "app".outbox o
    JOIN "platform".tenant t ON t.id = o.tenant_id
   WHERE o.status = 'FAILED'
   ORDER BY o.created_at DESC
   LIMIT least(greatest(p_limit, 1), 200)
$$;

CREATE OR REPLACE FUNCTION "platform_api".outbox_stats()
  RETURNS TABLE (status text, topic text, count bigint, oldest timestamp)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.status::text, o.topic, count(*), min(o.created_at)
    FROM "app".outbox o
   WHERE o.status <> 'DONE'
   GROUP BY o.status, o.topic
$$;

CREATE OR REPLACE FUNCTION "platform_api".outbox_retry(p_id uuid)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE "app".outbox
     SET status = 'PENDING', attempts = 0, available_at = now(), last_error = NULL
   WHERE id = p_id AND status = 'FAILED'
  RETURNING true
$$;

REVOKE ALL ON FUNCTION "platform_api".outbox_dead_letters(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION "platform_api".outbox_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION "platform_api".outbox_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "platform_api".outbox_dead_letters(int) TO gym_platform;
GRANT EXECUTE ON FUNCTION "platform_api".outbox_stats() TO gym_platform;
GRANT EXECUTE ON FUNCTION "platform_api".outbox_retry(uuid) TO gym_platform;
