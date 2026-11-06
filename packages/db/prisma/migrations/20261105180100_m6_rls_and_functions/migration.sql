-- M6: row-level security for the messaging, automation and retention tables; guards; the Meta
-- webhook routing lookup.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'whatsapp_account', 'message_template', 'suppression_record', 'conversation', 'inbound_message',
    'outbound_message', 'message_event', 'segment', 'campaign_recipient', 'automation_workflow',
    'automation_workflow_version', 'automation_execution', 'automation_step_run', 'retention_rule',
    'retention_flag', 'recovery_outcome'
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

-- One connected WhatsApp number per gym, and a number can belong to only one gym at a time.
CREATE UNIQUE INDEX whatsapp_account_one_active ON "app".whatsapp_account (tenant_id) WHERE status <> 'DISCONNECTED';
CREATE UNIQUE INDEX whatsapp_account_number_owner ON "app".whatsapp_account (phone_number_id) WHERE status <> 'DISCONNECTED';

-- Consent belongs to exactly one person: a member or a lead.
ALTER TABLE "app".contact_consent ADD CONSTRAINT contact_consent_one_subject
  CHECK ((member_id IS NOT NULL) <> (lead_id IS NOT NULL));
CREATE INDEX contact_consent_lead ON "app".contact_consent (tenant_id, lead_id, channel, purpose, captured_at)
  WHERE lead_id IS NOT NULL;

-- One live suppression per address and channel.
CREATE UNIQUE INDEX suppression_record_active ON "app".suppression_record (tenant_id, channel, address)
  WHERE lifted_at IS NULL;

-- One open retention flag per subject and rule.
CREATE UNIQUE INDEX retention_flag_one_open ON "app".retention_flag (tenant_id, kind, coalesce(member_id, lead_id))
  WHERE status IN ('OPEN', 'ACTIONED');
ALTER TABLE "app".retention_flag ADD CONSTRAINT retention_flag_subject CHECK (member_id IS NOT NULL OR lead_id IS NOT NULL);

ALTER TABLE "app".campaign ADD CONSTRAINT campaign_send_ranges
  CHECK (throttle_per_minute BETWEEN 1 AND 1000 AND attribution_days BETWEEN 1 AND 90);
ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m6_ranges CHECK (marketing_daily_cap BETWEEN 0 AND 10);
ALTER TABLE "app".retention_rule ADD CONSTRAINT retention_rule_threshold CHECK (threshold > 0);
ALTER TABLE "app".outbound_message ADD CONSTRAINT outbound_message_shape
  CHECK (attempts >= 0 AND (kind = 'TEXT' OR template_name IS NOT NULL));

-- History is kept. Versions, inbound messages and recovery outcomes are append-only; nothing
-- here is deleted by the application (archived, cancelled or lifted instead).
REVOKE UPDATE, DELETE ON "app".automation_workflow_version, "app".inbound_message, "app".recovery_outcome FROM gym_app;
REVOKE DELETE ON "app".whatsapp_account, "app".message_template, "app".suppression_record, "app".conversation,
  "app".outbound_message, "app".message_event, "app".segment, "app".campaign_recipient, "app".automation_workflow,
  "app".automation_execution, "app".automation_step_run, "app".retention_rule, "app".retention_flag FROM gym_app;

-- ---------------------------------------------------------------------------------
-- One platform webhook endpoint receives every gym's Meta events (D-12). After the signature
-- check (Meta app secret), route by phone number id (falling back to WABA id) to the tenant.
-- Disconnected accounts are not routed.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app".whatsapp_route(p_phone_number_id text, p_waba_id text)
  RETURNS TABLE (tenant_id uuid, account_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.tenant_id, a.id
    FROM "app".whatsapp_account a
   WHERE a.status <> 'DISCONNECTED'
     AND ((p_phone_number_id IS NOT NULL AND a.phone_number_id = p_phone_number_id)
          OR (p_phone_number_id IS NULL AND a.waba_id = p_waba_id))
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION "app".whatsapp_route(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".whatsapp_route(text, text) TO gym_app;
