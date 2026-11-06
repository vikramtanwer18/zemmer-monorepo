-- M3: row-level security for every new tenant table, one-time-use and no-double-booking
-- guarantees as partial unique indexes, CHECK constraints, and append-only rules.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member_pass', 'scan_device', 'attendance_event', 'class_category', 'room', 'class_template',
    'class_session', 'booking', 'waitlist_entry', 'staff_profile', 'trainer_profile',
    'trainer_certification', 'staff_availability', 'trainer_client_assignment', 'pt_package',
    'pt_package_balance', 'pt_appointment', 'entitlement_ledger'
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

-- ---------------------------------------------------------------------------------
-- D-09: each (passId, timeStep) is accepted once. Redis SET NX stops replays fast; this index
-- is the durable guarantee (a replay that slips past Redis fails the insert).
-- ---------------------------------------------------------------------------------
CREATE UNIQUE INDEX attendance_event_qr_once
  ON "app".attendance_event (tenant_id, pass_id, time_step)
  WHERE result = 'ACCEPTED' AND method = 'QR';

-- One active pass per member; reissuing revokes the old one in the same transaction.
CREATE UNIQUE INDEX member_pass_one_active
  ON "app".member_pass (tenant_id, member_id)
  WHERE status = 'ACTIVE';

-- One live booking per member per session, one waiting entry, one current trainer assignment.
CREATE UNIQUE INDEX booking_one_live_per_member
  ON "app".booking (tenant_id, session_id, member_id)
  WHERE status <> 'CANCELLED';
CREATE UNIQUE INDEX waitlist_one_waiting_per_member
  ON "app".waitlist_entry (tenant_id, session_id, member_id)
  WHERE status = 'WAITING';
CREATE UNIQUE INDEX trainer_client_one_current
  ON "app".trainer_client_assignment (tenant_id, trainer_id, member_id)
  WHERE ended_at IS NULL;

-- Ledger idempotency: one grant per membership / package, one entry per booking or session
-- per reason, so a retried job or a double click can't move a balance twice.
CREATE UNIQUE INDEX entitlement_grant_once_membership
  ON "app".entitlement_ledger (tenant_id, membership_id)
  WHERE reason = 'GRANT' AND membership_id IS NOT NULL;
CREATE UNIQUE INDEX entitlement_grant_once_pt
  ON "app".entitlement_ledger (tenant_id, pt_balance_id)
  WHERE reason = 'GRANT' AND pt_balance_id IS NOT NULL;
CREATE UNIQUE INDEX entitlement_once_per_booking
  ON "app".entitlement_ledger (tenant_id, booking_id, reason)
  WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX entitlement_once_per_appointment
  ON "app".entitlement_ledger (tenant_id, appointment_id, reason)
  WHERE appointment_id IS NOT NULL;

-- ---------------------------------------------------------------------------------
-- No overbooking, ever: even a buggy caller can't push booked_count past capacity.
-- ---------------------------------------------------------------------------------
ALTER TABLE "app".class_session ADD CONSTRAINT class_session_capacity_positive CHECK (capacity > 0);
ALTER TABLE "app".class_session ADD CONSTRAINT class_session_booked_within_capacity
  CHECK (booked_count >= 0 AND booked_count <= capacity);
ALTER TABLE "app".class_session ADD CONSTRAINT class_session_times_ordered CHECK (ends_at > starts_at);

ALTER TABLE "app".class_template ADD CONSTRAINT class_template_capacity_positive CHECK (capacity > 0);
ALTER TABLE "app".class_template ADD CONSTRAINT class_template_duration_positive
  CHECK (duration_minutes > 0 AND duration_minutes <= 1440);
ALTER TABLE "app".class_template ADD CONSTRAINT class_template_start_minute_range
  CHECK (start_minute >= 0 AND start_minute < 1440);
ALTER TABLE "app".class_template ADD CONSTRAINT class_template_days_valid
  CHECK (cardinality(by_days) > 0 AND by_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]);
ALTER TABLE "app".class_template ADD CONSTRAINT class_template_count_positive
  CHECK (occurrence_count IS NULL OR occurrence_count > 0);

ALTER TABLE "app".waitlist_entry ADD CONSTRAINT waitlist_position_positive CHECK (position > 0);

ALTER TABLE "app".staff_availability ADD CONSTRAINT staff_availability_minutes
  CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute);
ALTER TABLE "app".staff_availability ADD CONSTRAINT staff_availability_kind_fields
  CHECK (
    (kind = 'WEEKLY' AND day_of_week BETWEEN 1 AND 7 AND date IS NULL)
    OR (kind = 'EXCEPTION' AND date IS NOT NULL AND day_of_week IS NULL)
  );

ALTER TABLE "app".pt_package ADD CONSTRAINT pt_package_values
  CHECK (session_count > 0 AND validity_days > 0 AND session_minutes > 0 AND price_minor >= 0);
ALTER TABLE "app".pt_package_balance ADD CONSTRAINT pt_balance_sessions_positive CHECK (sessions_total > 0);
ALTER TABLE "app".pt_appointment ADD CONSTRAINT pt_appointment_times_ordered CHECK (ends_at > starts_at);

ALTER TABLE "app".entitlement_ledger ADD CONSTRAINT entitlement_delta_nonzero CHECK (delta <> 0);
ALTER TABLE "app".entitlement_ledger ADD CONSTRAINT entitlement_source_matches_kind
  CHECK (
    (kind = 'CLASS_CREDIT' AND membership_id IS NOT NULL AND pt_balance_id IS NULL)
    OR (kind = 'PT_SESSION' AND pt_balance_id IS NOT NULL AND membership_id IS NULL)
  );

ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m3_ranges
  CHECK (
    checkin_duplicate_minutes BETWEEN 0 AND 1440
    AND booking_reminder_hours BETWEEN 0 AND 168
    AND pt_cancel_cutoff_hours BETWEEN 0 AND 168
  );

-- ---------------------------------------------------------------------------------
-- History is never deleted by the application.
-- ---------------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "app".entitlement_ledger FROM gym_app;
REVOKE DELETE ON "app".attendance_event, "app".member_pass, "app".booking, "app".waitlist_entry,
  "app".trainer_client_assignment, "app".pt_package_balance, "app".pt_appointment FROM gym_app;

-- An attendance record keeps who/what/how forever; a correction may only move its time or void
-- it (both audited by the service).
CREATE OR REPLACE FUNCTION "app".attendance_event_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.branch_id, NEW.member_id, NEW.type, NEW.method, NEW.result,
      NEW.reject_code, NEW.pass_id, NEW.time_step, NEW.scanned_by_user_id, NEW.device_id,
      NEW.reason, NEW.overridden, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.branch_id, OLD.member_id, OLD.type, OLD.method, OLD.result,
      OLD.reject_code, OLD.pass_id, OLD.time_step, OLD.scanned_by_user_id, OLD.device_id,
      OLD.reason, OLD.overridden, OLD.created_at)
  THEN
    RAISE EXCEPTION 'attendance records are immutable; correct the time or void it instead'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'a voided attendance record cannot be restored' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER attendance_event_guard
  BEFORE UPDATE ON "app".attendance_event
  FOR EACH ROW EXECUTE FUNCTION "app".attendance_event_guard();
