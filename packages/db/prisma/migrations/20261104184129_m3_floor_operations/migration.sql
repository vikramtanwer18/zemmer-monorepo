-- CreateEnum
CREATE TYPE "app"."PassStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "app"."AttendanceType" AS ENUM ('CHECK_IN', 'CHECK_OUT');

-- CreateEnum
CREATE TYPE "app"."AttendanceMethod" AS ENUM ('QR', 'MANUAL', 'CORRECTION');

-- CreateEnum
CREATE TYPE "app"."AttendanceResult" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "app"."DuesCheckinPolicy" AS ENUM ('WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "app"."RecordStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "app"."ClassSessionStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "app"."BookingStatus" AS ENUM ('BOOKED', 'CANCELLED', 'ATTENDED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "app"."BookingSource" AS ENUM ('MEMBER_APP', 'STAFF', 'WAITLIST');

-- CreateEnum
CREATE TYPE "app"."WaitlistStatus" AS ENUM ('WAITING', 'PROMOTED', 'LEFT', 'SKIPPED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "app"."EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT');

-- CreateEnum
CREATE TYPE "app"."PayBasis" AS ENUM ('MONTHLY', 'HOURLY', 'PER_SESSION');

-- CreateEnum
CREATE TYPE "app"."AvailabilityKind" AS ENUM ('WEEKLY', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "app"."PtBalanceStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."PtAppointmentStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."EntitlementKind" AS ENUM ('CLASS_CREDIT', 'PT_SESSION');

-- CreateEnum
CREATE TYPE "app"."EntitlementReason" AS ENUM ('GRANT', 'BOOKING', 'BOOKING_RETURNED', 'SESSION_COMPLETED', 'SESSION_NO_SHOW', 'ADJUSTMENT', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "app"."FilePurpose" ADD VALUE 'MEMBER_PHOTO';
ALTER TYPE "app"."FilePurpose" ADD VALUE 'CERTIFICATE';

-- AlterEnum
ALTER TYPE "app"."InvoiceLineKind" ADD VALUE 'PT_PACKAGE';

-- AlterTable
ALTER TABLE "app"."branch" ADD COLUMN     "checkout_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "app"."member_profile" ADD COLUMN     "photo_file_id" UUID;

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "auto_mark_class_attendance" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "booking_reminder_hours" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "checkin_duplicate_minutes" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "dues_at_checkin" "app"."DuesCheckinPolicy" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "late_cancel_forfeits_credit" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pt_cancel_cutoff_hours" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "pt_no_show_consumes_session" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "app"."member_pass" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "pass_id" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "status" "app"."PassStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,
    "revoked_reason" TEXT,

    CONSTRAINT "member_pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."scan_device" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_seen_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."attendance_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "member_id" UUID,
    "type" "app"."AttendanceType" NOT NULL DEFAULT 'CHECK_IN',
    "method" "app"."AttendanceMethod" NOT NULL,
    "result" "app"."AttendanceResult" NOT NULL,
    "reject_code" TEXT,
    "pass_id" TEXT,
    "time_step" INTEGER,
    "scanned_by_user_id" UUID,
    "device_id" UUID,
    "reason" TEXT,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "original_occurred_at" TIMESTAMP(3),
    "corrected_at" TIMESTAMP(3),
    "corrected_by_id" UUID,
    "voided_at" TIMESTAMP(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."class_category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#204289',
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."room" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."class_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trainer_id" UUID,
    "room_id" UUID,
    "capacity" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "by_days" INTEGER[],
    "start_date" DATE NOT NULL,
    "until_date" DATE,
    "occurrence_count" INTEGER,
    "eligible_plan_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "booking_opens_hours" INTEGER NOT NULL DEFAULT 168,
    "booking_closes_minutes" INTEGER NOT NULL DEFAULT 0,
    "cancel_cutoff_minutes" INTEGER NOT NULL DEFAULT 120,
    "waitlist_enabled" BOOLEAN NOT NULL DEFAULT true,
    "waitlist_max" INTEGER,
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."class_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "template_id" UUID,
    "template_version" INTEGER,
    "occurrence_date" DATE,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "trainer_id" UUID,
    "room_id" UUID,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "booked_count" INTEGER NOT NULL DEFAULT 0,
    "eligible_plan_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "booking_opens_hours" INTEGER NOT NULL,
    "booking_closes_minutes" INTEGER NOT NULL,
    "cancel_cutoff_minutes" INTEGER NOT NULL,
    "waitlist_enabled" BOOLEAN NOT NULL,
    "waitlist_max" INTEGER,
    "status" "app"."ClassSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "conflict_note" TEXT,
    "reminder_sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."booking" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "membership_id" UUID,
    "status" "app"."BookingStatus" NOT NULL DEFAULT 'BOOKED',
    "source" "app"."BookingSource" NOT NULL,
    "used_credit" BOOLEAN NOT NULL DEFAULT false,
    "late_cancel" BOOLEAN NOT NULL DEFAULT false,
    "booked_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "marked_at" TIMESTAMP(3),
    "marked_by_id" UUID,
    "reminder_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."waitlist_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "app"."WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "booking_id" UUID,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."staff_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone" TEXT,
    "job_title" TEXT,
    "employment_type" "app"."EmploymentType",
    "start_date" DATE,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "pay_basis" "app"."PayBasis",
    "pay_rate_minor" BIGINT,
    "pay_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trainer_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" TEXT,
    "visible_to_members" BOOLEAN NOT NULL DEFAULT true,
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trainer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trainer_certification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "file_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."staff_availability" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID,
    "kind" "app"."AvailabilityKind" NOT NULL,
    "day_of_week" INTEGER,
    "date" DATE,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trainer_client_assignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "note" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" UUID,
    "ended_at" TIMESTAMP(3),
    "ended_by_id" UUID,
    "end_reason" TEXT,

    CONSTRAINT "trainer_client_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."pt_package" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "session_count" INTEGER NOT NULL,
    "validity_days" INTEGER NOT NULL,
    "session_minutes" INTEGER NOT NULL DEFAULT 60,
    "price_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 1800,
    "sac_code" TEXT NOT NULL DEFAULT '999723',
    "status" "app"."RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pt_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."pt_package_balance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID,
    "trainer_id" UUID,
    "name" TEXT NOT NULL,
    "sessions_total" INTEGER NOT NULL,
    "session_minutes" INTEGER NOT NULL,
    "validity_days" INTEGER NOT NULL,
    "status" "app"."PtBalanceStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "activated_at" TIMESTAMP(3),
    "expires_on" DATE,
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pt_package_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."pt_appointment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "app"."PtAppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "created_by_id" UUID,
    "marked_at" TIMESTAMP(3),
    "marked_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pt_appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."entitlement_ledger" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "app"."EntitlementKind" NOT NULL,
    "membership_id" UUID,
    "pt_balance_id" UUID,
    "delta" INTEGER NOT NULL,
    "reason" "app"."EntitlementReason" NOT NULL,
    "booking_id" UUID,
    "appointment_id" UUID,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_pass_pass_id_key" ON "app"."member_pass"("pass_id");

-- CreateIndex
CREATE INDEX "member_pass_tenant_id_member_id_idx" ON "app"."member_pass"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_pass_tenant_id_id_key" ON "app"."member_pass"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scan_device_tenant_id_id_key" ON "app"."scan_device"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scan_device_tenant_id_branch_id_name_key" ON "app"."scan_device"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE INDEX "attendance_event_tenant_id_branch_id_occurred_at_idx" ON "app"."attendance_event"("tenant_id", "branch_id", "occurred_at");

-- CreateIndex
CREATE INDEX "attendance_event_tenant_id_member_id_occurred_at_idx" ON "app"."attendance_event"("tenant_id", "member_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_event_tenant_id_id_key" ON "app"."attendance_event"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_category_tenant_id_id_key" ON "app"."class_category"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_category_tenant_id_name_key" ON "app"."class_category"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "room_tenant_id_id_key" ON "app"."room"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "room_tenant_id_branch_id_name_key" ON "app"."room"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE INDEX "class_template_tenant_id_branch_id_status_idx" ON "app"."class_template"("tenant_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "class_template_tenant_id_id_key" ON "app"."class_template"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "class_session_tenant_id_branch_id_starts_at_idx" ON "app"."class_session"("tenant_id", "branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "class_session_tenant_id_trainer_id_starts_at_idx" ON "app"."class_session"("tenant_id", "trainer_id", "starts_at");

-- CreateIndex
CREATE INDEX "class_session_tenant_id_status_ends_at_idx" ON "app"."class_session"("tenant_id", "status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "class_session_tenant_id_id_key" ON "app"."class_session"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_session_tenant_id_template_id_occurrence_date_key" ON "app"."class_session"("tenant_id", "template_id", "occurrence_date");

-- CreateIndex
CREATE INDEX "booking_tenant_id_session_id_status_idx" ON "app"."booking"("tenant_id", "session_id", "status");

-- CreateIndex
CREATE INDEX "booking_tenant_id_member_id_created_at_idx" ON "app"."booking"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_tenant_id_id_key" ON "app"."booking"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entry_tenant_id_id_key" ON "app"."waitlist_entry"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entry_tenant_id_session_id_position_key" ON "app"."waitlist_entry"("tenant_id", "session_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profile_tenant_id_id_key" ON "app"."staff_profile"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profile_tenant_id_user_id_key" ON "app"."staff_profile"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trainer_profile_tenant_id_id_key" ON "app"."trainer_profile"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trainer_profile_tenant_id_user_id_key" ON "app"."trainer_profile"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "trainer_certification_tenant_id_trainer_id_idx" ON "app"."trainer_certification"("tenant_id", "trainer_id");

-- CreateIndex
CREATE INDEX "staff_availability_tenant_id_user_id_kind_idx" ON "app"."staff_availability"("tenant_id", "user_id", "kind");

-- CreateIndex
CREATE INDEX "trainer_client_assignment_tenant_id_trainer_id_idx" ON "app"."trainer_client_assignment"("tenant_id", "trainer_id");

-- CreateIndex
CREATE INDEX "trainer_client_assignment_tenant_id_member_id_idx" ON "app"."trainer_client_assignment"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "pt_package_tenant_id_id_key" ON "app"."pt_package"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pt_package_tenant_id_code_key" ON "app"."pt_package"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "pt_package_balance_tenant_id_member_id_idx" ON "app"."pt_package_balance"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "pt_package_balance_tenant_id_invoice_id_idx" ON "app"."pt_package_balance"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "pt_package_balance_tenant_id_id_key" ON "app"."pt_package_balance"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "pt_appointment_tenant_id_trainer_id_starts_at_idx" ON "app"."pt_appointment"("tenant_id", "trainer_id", "starts_at");

-- CreateIndex
CREATE INDEX "pt_appointment_tenant_id_member_id_starts_at_idx" ON "app"."pt_appointment"("tenant_id", "member_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "pt_appointment_tenant_id_id_key" ON "app"."pt_appointment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "entitlement_ledger_tenant_id_membership_id_idx" ON "app"."entitlement_ledger"("tenant_id", "membership_id");

-- CreateIndex
CREATE INDEX "entitlement_ledger_tenant_id_pt_balance_id_idx" ON "app"."entitlement_ledger"("tenant_id", "pt_balance_id");

-- CreateIndex
CREATE INDEX "entitlement_ledger_tenant_id_member_id_kind_idx" ON "app"."entitlement_ledger"("tenant_id", "member_id", "kind");

-- AddForeignKey
ALTER TABLE "app"."member_profile" ADD CONSTRAINT "member_profile_tenant_id_photo_file_id_fkey" FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "app"."file_record"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_pass" ADD CONSTRAINT "member_pass_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."scan_device" ADD CONSTRAINT "scan_device_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_device_id_fkey" FOREIGN KEY ("tenant_id", "device_id") REFERENCES "app"."scan_device"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_category" ADD CONSTRAINT "class_category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."room" ADD CONSTRAINT "room_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_template" ADD CONSTRAINT "class_template_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_template" ADD CONSTRAINT "class_template_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "app"."class_category"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_template" ADD CONSTRAINT "class_template_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_template" ADD CONSTRAINT "class_template_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "app"."room"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_session" ADD CONSTRAINT "class_session_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_session" ADD CONSTRAINT "class_session_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "app"."class_template"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_session" ADD CONSTRAINT "class_session_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "app"."class_category"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_session" ADD CONSTRAINT "class_session_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."class_session" ADD CONSTRAINT "class_session_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "app"."room"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."booking" ADD CONSTRAINT "booking_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "app"."class_session"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."booking" ADD CONSTRAINT "booking_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."booking" ADD CONSTRAINT "booking_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."waitlist_entry" ADD CONSTRAINT "waitlist_entry_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "app"."class_session"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."waitlist_entry" ADD CONSTRAINT "waitlist_entry_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."staff_profile" ADD CONSTRAINT "staff_profile_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."tenant_membership"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_profile" ADD CONSTRAINT "trainer_profile_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."tenant_membership"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_certification" ADD CONSTRAINT "trainer_certification_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_certification" ADD CONSTRAINT "trainer_certification_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "app"."file_record"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."staff_availability" ADD CONSTRAINT "staff_availability_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."tenant_membership"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."staff_availability" ADD CONSTRAINT "staff_availability_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_client_assignment" ADD CONSTRAINT "trainer_client_assignment_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_client_assignment" ADD CONSTRAINT "trainer_client_assignment_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package" ADD CONSTRAINT "pt_package_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package_balance" ADD CONSTRAINT "pt_package_balance_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package_balance" ADD CONSTRAINT "pt_package_balance_tenant_id_package_id_fkey" FOREIGN KEY ("tenant_id", "package_id") REFERENCES "app"."pt_package"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package_balance" ADD CONSTRAINT "pt_package_balance_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package_balance" ADD CONSTRAINT "pt_package_balance_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "app"."gym_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_package_balance" ADD CONSTRAINT "pt_package_balance_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_appointment" ADD CONSTRAINT "pt_appointment_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_appointment" ADD CONSTRAINT "pt_appointment_tenant_id_trainer_id_fkey" FOREIGN KEY ("tenant_id", "trainer_id") REFERENCES "app"."trainer_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_appointment" ADD CONSTRAINT "pt_appointment_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."pt_appointment" ADD CONSTRAINT "pt_appointment_tenant_id_balance_id_fkey" FOREIGN KEY ("tenant_id", "balance_id") REFERENCES "app"."pt_package_balance"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."entitlement_ledger" ADD CONSTRAINT "entitlement_ledger_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."entitlement_ledger" ADD CONSTRAINT "entitlement_ledger_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."entitlement_ledger" ADD CONSTRAINT "entitlement_ledger_tenant_id_pt_balance_id_fkey" FOREIGN KEY ("tenant_id", "pt_balance_id") REFERENCES "app"."pt_package_balance"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
