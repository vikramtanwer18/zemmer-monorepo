-- M2: row-level security for every new tenant table, immutability guards for financial records,
-- and the outbox claim function used by the worker relay.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_counter', 'file_record', 'member_profile', 'member_note', 'member_document',
    'contact_consent', 'membership_plan', 'plan_branch', 'coupon', 'membership',
    'membership_event', 'membership_freeze', 'invoice_series', 'gym_invoice', 'gym_invoice_line',
    'credit_note', 'credit_note_line', 'gym_payment', 'payment_allocation', 'member_credit_entry',
    'notification', 'notification_preference', 'email_template', 'data_job'
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

-- Append-only history for the application role.
REVOKE UPDATE, DELETE ON "app".membership_event, "app".contact_consent, "app".member_credit_entry,
  "app".gym_invoice_line, "app".credit_note, "app".credit_note_line FROM gym_app;
-- Invoices and payments are never deleted (void instead).
REVOKE DELETE ON "app".gym_invoice, "app".gym_payment, "app".payment_allocation FROM gym_app;

-- Issued invoices are immutable (D-11): only the status, the stored PDF and the void fields may
-- change. Corrections go through credit notes.
CREATE OR REPLACE FUNCTION "app".gym_invoice_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.branch_id, NEW.member_id, NEW.membership_id, NEW.number, NEW.document_type,
      NEW.issue_date, NEW.due_date, NEW.currency, NEW.prices_include_tax, NEW.place_of_supply,
      NEW.taxable_minor, NEW.cgst_minor, NEW.sgst_minor, NEW.igst_minor, NEW.total_minor,
      NEW.supplier, NEW.recipient, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.branch_id, OLD.member_id, OLD.membership_id, OLD.number, OLD.document_type,
      OLD.issue_date, OLD.due_date, OLD.currency, OLD.prices_include_tax, OLD.place_of_supply,
      OLD.taxable_minor, OLD.cgst_minor, OLD.sgst_minor, OLD.igst_minor, OLD.total_minor,
      OLD.supplier, OLD.recipient, OLD.created_at)
  THEN
    RAISE EXCEPTION 'issued invoice % is immutable; issue a credit note instead', OLD.number
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER gym_invoice_immutable
  BEFORE UPDATE ON "app".gym_invoice
  FOR EACH ROW EXECUTE FUNCTION "app".gym_invoice_immutable();

-- The same for payments: only the void fields (and proof file) may change.
CREATE OR REPLACE FUNCTION "app".gym_payment_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.branch_id, NEW.member_id, NEW.method, NEW.amount_minor, NEW.currency,
      NEW.received_at, NEW.receipt_number, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.branch_id, OLD.member_id, OLD.method, OLD.amount_minor, OLD.currency,
      OLD.received_at, OLD.receipt_number, OLD.created_at)
  THEN
    RAISE EXCEPTION 'recorded payment % is immutable; void it instead', OLD.receipt_number
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER gym_payment_immutable
  BEFORE UPDATE ON "app".gym_payment
  FOR EACH ROW EXECUTE FUNCTION "app".gym_payment_immutable();

-- Money is never negative where it shouldn't be.
ALTER TABLE "app".gym_payment ADD CONSTRAINT gym_payment_amount_positive CHECK (amount_minor > 0);
ALTER TABLE "app".payment_allocation ADD CONSTRAINT payment_allocation_amount_positive CHECK (amount_minor > 0);
ALTER TABLE "app".payment_allocation ADD CONSTRAINT payment_allocation_source_payment
  CHECK ((source = 'PAYMENT') = (payment_id IS NOT NULL));
ALTER TABLE "app".gym_invoice ADD CONSTRAINT gym_invoice_total_nonnegative CHECK (total_minor >= 0);
ALTER TABLE "app".membership ADD CONSTRAINT membership_dates_ordered CHECK (end_date >= start_date);
ALTER TABLE "app".invoice_series ADD CONSTRAINT invoice_series_next_positive CHECK (next_number >= 1);

-- ---------------------------------------------------------------------------------
-- Outbox relay (design in docs/ARCHITECTURE.md). The worker runs as gym_app, which only sees
-- one tenant at a time, so claiming due rows across tenants goes through these functions.
-- ---------------------------------------------------------------------------------

-- Claims up to p_limit due rows: pushes available_at forward by the lease so a crashed relay's
-- rows come back, and counts the attempt. Rows past p_max_attempts become FAILED.
CREATE OR REPLACE FUNCTION "app".outbox_claim(p_limit int, p_lease_seconds int, p_max_attempts int)
  RETURNS TABLE (id uuid, tenant_id uuid, topic text, payload jsonb, attempts int)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE "app".outbox o
     SET status = 'FAILED', last_error = coalesce(o.last_error, 'too many attempts')
   WHERE o.status = 'PENDING' AND o.attempts >= p_max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
      FROM "app".outbox o
     WHERE o.status = 'PENDING' AND o.available_at <= now()
     ORDER BY o.available_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE "app".outbox o
     SET available_at = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    FROM due
   WHERE o.id = due.id
  RETURNING o.id, o.tenant_id, o.topic, o.payload::jsonb, o.attempts;
END
$$;

CREATE OR REPLACE FUNCTION "app".outbox_complete(p_id uuid)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE "app".outbox SET status = 'DONE', processed_at = now() WHERE id = p_id
$$;

CREATE OR REPLACE FUNCTION "app".outbox_fail(p_id uuid, p_error text)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE "app".outbox SET last_error = left(p_error, 1000) WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION "app".outbox_claim(int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app".outbox_complete(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app".outbox_fail(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".outbox_claim(int, int, int) TO gym_app;
GRANT EXECUTE ON FUNCTION "app".outbox_complete(uuid) TO gym_app;
GRANT EXECUTE ON FUNCTION "app".outbox_fail(uuid, text) TO gym_app;

-- ---------------------------------------------------------------------------------
-- Member join link: /join/{slug} must find the tenant before anyone is signed in.
-- Returns only what the join page shows, and only for active tenants that allow self-signup.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app".find_join_tenant(p_slug text)
  RETURNS TABLE (tenant_id uuid, display_name text, needs_approval boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, t.display_name, s.member_join_approval
    FROM "platform".tenant t
    JOIN "app".tenant_settings s ON s.tenant_id = t.id
   WHERE t.slug = p_slug AND t.status = 'ACTIVE' AND s.member_self_signup
$$;

REVOKE ALL ON FUNCTION "app".find_join_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".find_join_tenant(text) TO gym_app;
