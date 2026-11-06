-- M4: row-level security for the new gym tables, the webhook integration lookup, guards, and the
-- platform billing grants. SaaS billing and gym billing share no tables (spec §5).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_integration', 'payment_link', 'payment_link_invoice', 'webhook_event', 'refund',
    'reconciliation_run', 'reconciliation_item', 'member_data_request'
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

-- One connected payment account per gym.
CREATE UNIQUE INDEX payment_integration_one_active
  ON "app".payment_integration (tenant_id)
  WHERE status = 'ACTIVE';

ALTER TABLE "app".payment_link ADD CONSTRAINT payment_link_amounts
  CHECK (amount_minor > 0 AND amount_paid_minor >= 0 AND (min_partial_minor IS NULL OR min_partial_minor > 0));
ALTER TABLE "app".refund ADD CONSTRAINT refund_amount_positive CHECK (amount_minor > 0);
ALTER TABLE "app".refund ADD CONSTRAINT refund_manual_has_method
  CHECK (kind = 'ONLINE' OR method IS NOT NULL);
ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m4_ranges
  CHECK (
    payment_link_expiry_days BETWEEN 1 AND 180
    AND online_min_partial_minor >= 100
    AND (refund_approval_threshold_minor IS NULL OR refund_approval_threshold_minor > 0)
  );

-- Money history is never deleted by the application.
REVOKE DELETE ON "app".payment_link, "app".payment_link_invoice, "app".webhook_event,
  "app".refund, "app".reconciliation_run, "app".reconciliation_item FROM gym_app;

-- ---------------------------------------------------------------------------------
-- Webhooks arrive at /api/webhooks/razorpay/{integrationId} before any tenant is known. This
-- returns just enough to verify the signature and then work inside that tenant (withTenant).
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app".webhook_integration(p_integration_id uuid)
  RETURNS TABLE (tenant_id uuid, provider text, webhook_secret_enc text, status text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.tenant_id, i.provider::text, i.webhook_secret_enc, i.status::text
    FROM "app".payment_integration i
   WHERE i.id = p_integration_id
$$;

REVOKE ALL ON FUNCTION "app".webhook_integration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".webhook_integration(uuid) TO gym_app;

-- ---------------------------------------------------------------------------------
-- Platform billing. gym_platform (admin + platform jobs) owns these tables. gym_app may read the
-- public price list and announcements, and its own SaaS invoices/payments (owner billing page);
-- it can never read the platform payment account, platform webhooks or dunning records.
-- ---------------------------------------------------------------------------------
GRANT SELECT ON "platform".saas_plan_price, "platform".announcement TO gym_app;
GRANT SELECT ON "platform".platform_invoice, "platform".platform_payment TO gym_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_invoice', 'platform_payment']
  LOOP
    EXECUTE format('ALTER TABLE "platform".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_all ON "platform".%I TO gym_platform USING (true) WITH CHECK (true)',
      t
    );
    EXECUTE format(
      'CREATE POLICY tenant_read ON "platform".%I FOR SELECT TO gym_app '
      'USING (tenant_id = "app".current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

-- Issued SaaS invoices never change except their status (and payment link).
CREATE OR REPLACE FUNCTION "platform".platform_invoice_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.number, NEW.issue_date, NEW.supplier, NEW.recipient, NEW.taxable_minor,
      NEW.cgst_minor, NEW.sgst_minor, NEW.igst_minor, NEW.total_minor, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.number, OLD.issue_date, OLD.supplier, OLD.recipient, OLD.taxable_minor,
      OLD.cgst_minor, OLD.sgst_minor, OLD.igst_minor, OLD.total_minor, OLD.created_at)
  THEN
    RAISE EXCEPTION 'issued SaaS invoice % is immutable', OLD.number USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_invoice_immutable
  BEFORE UPDATE ON "platform".platform_invoice
  FOR EACH ROW EXECUTE FUNCTION "platform".platform_invoice_immutable();

-- Starting prices (editable in the admin console). Half-yearly 10% and yearly 20% off monthly.
UPDATE "platform".saas_plan SET price_monthly_minor = CASE code
    WHEN 'starter' THEN 149900 WHEN 'growth' THEN 299900 WHEN 'pro' THEN 599900 END
  WHERE code IN ('starter', 'growth', 'pro') AND price_monthly_minor IS NULL;

INSERT INTO "platform".saas_plan_price (id, plan_id, cycle, amount_minor, currency)
SELECT gen_random_uuid(), p.id, c.cycle::"platform"."BillingCycle",
       CASE c.cycle
         WHEN 'MONTHLY' THEN p.price_monthly_minor
         WHEN 'HALF_YEARLY' THEN round(p.price_monthly_minor * 6 * 0.9)
         ELSE round(p.price_monthly_minor * 12 * 0.8)
       END,
       p.currency
  FROM "platform".saas_plan p
  CROSS JOIN (VALUES ('MONTHLY'), ('HALF_YEARLY'), ('YEARLY')) AS c(cycle)
 WHERE p.status = 'ACTIVE' AND p.price_monthly_minor IS NOT NULL
ON CONFLICT (plan_id, cycle) DO NOTHING;
