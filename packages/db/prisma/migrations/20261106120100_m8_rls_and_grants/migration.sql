-- M8: row-level security for the KPI rollup and the Copilot request log; the gym runtime's
-- read-only slice of the platform AI provider; value guards; AI usage for the operator console.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['metric_daily', 'ai_request_log']
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

-- Request logs are never edited (deleted only by the retention job).
REVOKE UPDATE ON "app".ai_request_log FROM gym_app;

ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m8_ranges CHECK (kpi_grace_days BETWEEN 0 AND 90);
ALTER TABLE "app".data_job ADD CONSTRAINT data_job_progress CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE "app".metric_daily ADD CONSTRAINT metric_daily_values CHECK (
  active_members >= 0 AND paused_members >= 0 AND new_members >= 0 AND check_ins >= 0 AND unique_visits >= 0
  AND payments_minor >= 0 AND refunds_minor >= 0);

-- ---------------------------------------------------------------------------------
-- AI provider: one row. The gym runtime may read what it needs to call the provider (the key is
-- sealed; only the server holding DATA_ENCRYPTION_KEY can open it) but not the admin's test notes.
-- ---------------------------------------------------------------------------------
ALTER TABLE "platform".ai_provider ADD CONSTRAINT ai_provider_values CHECK (
  id = 'default'
  AND base_url ~ '^https?://'
  AND timeout_ms BETWEEN 1000 AND 120000
  AND max_tokens BETWEEN 100 AND 8000
  AND log_retention_days BETWEEN 1 AND 365
  AND tenant_rate_per_minute BETWEEN 1 AND 120);

ALTER TABLE "platform".ai_provider ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON "platform".ai_provider TO gym_platform USING (true) WITH CHECK (true);
CREATE POLICY app_select ON "platform".ai_provider FOR SELECT TO gym_app USING (true);
GRANT SELECT (id, label, base_url, model, api_key_sealed, timeout_ms, max_tokens, enabled, supports_tools,
  log_retention_days, tenant_rate_per_minute) ON "platform".ai_provider TO gym_app;

-- Operator console: Copilot usage per gym since a date (counts and tokens only).
CREATE OR REPLACE FUNCTION "platform_api".ai_usage(p_since timestamptz)
  RETURNS TABLE (tenant_id uuid, requests bigint, fallbacks bigint, flagged bigint, errors bigint,
                 prompt_tokens bigint, completion_tokens bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.tenant_id,
         count(*),
         count(*) FILTER (WHERE l.outcome = 'FALLBACK'),
         count(*) FILTER (WHERE l.outcome = 'FLAGGED'),
         count(*) FILTER (WHERE l.outcome = 'ERROR'),
         coalesce(sum(l.prompt_tokens), 0)::bigint,
         coalesce(sum(l.completion_tokens), 0)::bigint
    FROM "app".ai_request_log l
   WHERE l.created_at >= p_since
   GROUP BY l.tenant_id
$$;

REVOKE ALL ON FUNCTION "platform_api".ai_usage(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "platform_api".ai_usage(timestamptz) TO gym_platform;
