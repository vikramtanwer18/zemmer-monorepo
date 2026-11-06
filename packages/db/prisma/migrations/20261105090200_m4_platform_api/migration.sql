-- M4: what SaaS invoices need about a gym (B2B recipient), without giving gym_platform access to
-- tenant tables: legal name, GSTIN and state from the gym's own settings.
CREATE OR REPLACE FUNCTION "platform_api".tenant_billing_identity(p_tenant_id uuid)
  RETURNS TABLE (legal_name text, display_name text, gstin text, state_code text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.legal_name, t.display_name,
         CASE WHEN s.gst_registered THEN s.gstin END,
         coalesce(s.state_code, (SELECT b.state_code FROM "app".branch b
                                  WHERE b.tenant_id = t.id ORDER BY b.created_at LIMIT 1))
    FROM "platform".tenant t
    LEFT JOIN "app".tenant_settings s ON s.tenant_id = t.id
   WHERE t.id = p_tenant_id
$$;

REVOKE ALL ON FUNCTION "platform_api".tenant_billing_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "platform_api".tenant_billing_identity(uuid) TO gym_platform;
