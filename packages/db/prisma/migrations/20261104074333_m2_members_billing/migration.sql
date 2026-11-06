-- CreateEnum
CREATE TYPE "app"."MemberStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "app"."MemberSource" AS ENUM ('STAFF', 'WALK_IN', 'SELF_SIGNUP', 'IMPORT', 'REFERRAL');

-- CreateEnum
CREATE TYPE "app"."Gender" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "app"."NoteVisibility" AS ENUM ('STAFF', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "app"."FilePurpose" AS ENUM ('MEMBER_DOCUMENT', 'PAYMENT_PROOF', 'INVOICE_PDF', 'EXPORT', 'IMPORT');

-- CreateEnum
CREATE TYPE "app"."ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."ConsentChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'SMS');

-- CreateEnum
CREATE TYPE "app"."ConsentPurpose" AS ENUM ('SERVICE', 'MARKETING');

-- CreateEnum
CREATE TYPE "app"."ConsentStatus" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "app"."ConsentMethod" AS ENUM ('STAFF_FORM', 'SELF_SERVICE', 'SIGNUP', 'IMPORT');

-- CreateEnum
CREATE TYPE "app"."DurationUnit" AS ENUM ('DAY', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "app"."AccessScope" AS ENUM ('ALL_BRANCHES', 'HOME_BRANCH', 'LISTED_BRANCHES');

-- CreateEnum
CREATE TYPE "app"."MembershipPlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "app"."RefundRule" AS ENUM ('NONE', 'PRORATA', 'FULL_BEFORE_START');

-- CreateEnum
CREATE TYPE "app"."CouponKind" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "app"."CouponStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "app"."MembershipState" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."MembershipEventType" AS ENUM ('CREATED', 'ACTIVATED', 'RENEWED', 'EXTENDED', 'FROZEN', 'UNFROZEN', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "app"."InvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "app"."InvoiceDocType" AS ENUM ('TAX_INVOICE', 'BILL');

-- CreateEnum
CREATE TYPE "app"."InvoiceLineKind" AS ENUM ('MEMBERSHIP', 'JOINING_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "app"."SeriesKind" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'RECEIPT');

-- CreateEnum
CREATE TYPE "app"."PaymentMethod" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CARD_TERMINAL', 'CHEQUE', 'OTHER', 'ONLINE');

-- CreateEnum
CREATE TYPE "app"."PaymentStatus" AS ENUM ('SUCCEEDED', 'VOID');

-- CreateEnum
CREATE TYPE "app"."AllocationSource" AS ENUM ('PAYMENT', 'CREDIT');

-- CreateEnum
CREATE TYPE "app"."CreditEntryKind" AS ENUM ('OVERPAYMENT', 'APPLIED', 'ALLOCATION_REVERSED', 'PAYMENT_VOID', 'MANUAL_REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "app"."NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "app"."NotificationCategory" AS ENUM ('SERVICE', 'MARKETING');

-- CreateEnum
CREATE TYPE "app"."DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."DataJobKind" AS ENUM ('MEMBER_IMPORT', 'MEMBER_EXPORT');

-- CreateEnum
CREATE TYPE "app"."DataJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "app"."MembershipActivation" AS ENUM ('FULL_PAYMENT', 'ANY_PAYMENT', 'IMMEDIATE');

-- CreateEnum
CREATE TYPE "app"."PlaceOfSupplyRule" AS ENUM ('BRANCH_STATE', 'MEMBER_STATE');

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "auto_apply_credit" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "default_sac_code" TEXT NOT NULL DEFAULT '999723',
ADD COLUMN     "expiry_reminder_days" INTEGER[] DEFAULT ARRAY[7, 3, 1]::INTEGER[],
ADD COLUMN     "invoice_due_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invoice_prefix" TEXT NOT NULL DEFAULT 'INV',
ADD COLUMN     "member_join_approval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "member_self_signup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "membership_activation" "app"."MembershipActivation" NOT NULL DEFAULT 'FULL_PAYMENT',
ADD COLUMN     "place_of_supply_rule" "app"."PlaceOfSupplyRule" NOT NULL DEFAULT 'BRANCH_STATE';

-- CreateTable
CREATE TABLE "app"."tenant_counter" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_counter_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "app"."file_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "purpose" "app"."FilePurpose" NOT NULL,
    "scan_status" "app"."ScanStatus" NOT NULL DEFAULT 'PENDING',
    "uploaded_by_user_id" UUID,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "home_branch_id" UUID NOT NULL,
    "user_id" UUID,
    "member_code" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "phone_verified_at" TIMESTAMP(3),
    "date_of_birth" DATE,
    "gender" "app"."Gender",
    "address_line1" TEXT,
    "city" TEXT,
    "state_code" TEXT,
    "postal_code" TEXT,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "status" "app"."MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "app"."MemberSource" NOT NULL DEFAULT 'STAFF',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_note" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "app"."NoteVisibility" NOT NULL DEFAULT 'STAFF',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."contact_consent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "channel" "app"."ConsentChannel" NOT NULL,
    "purpose" "app"."ConsentPurpose" NOT NULL,
    "status" "app"."ConsentStatus" NOT NULL,
    "method" "app"."ConsentMethod" NOT NULL,
    "captured_by_user_id" UUID,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidence" TEXT,

    CONSTRAINT "contact_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."membership_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" BIGINT NOT NULL,
    "joining_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "duration_unit" "app"."DurationUnit" NOT NULL,
    "duration_count" INTEGER NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 1800,
    "sac_code" TEXT NOT NULL DEFAULT '999723',
    "is_trial" BOOLEAN NOT NULL DEFAULT false,
    "access_scope" "app"."AccessScope" NOT NULL DEFAULT 'HOME_BRANCH',
    "access_windows" JSONB,
    "entitlements" JSONB NOT NULL DEFAULT '{}',
    "freeze_max_days" INTEGER NOT NULL DEFAULT 0,
    "freeze_max_times" INTEGER NOT NULL DEFAULT 0,
    "freeze_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "grace_days" INTEGER NOT NULL DEFAULT 0,
    "allow_add_on" BOOLEAN NOT NULL DEFAULT false,
    "refund_rule" "app"."RefundRule" NOT NULL DEFAULT 'NONE',
    "cancellation_policy" TEXT,
    "status" "app"."MembershipPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."plan_branch" (
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "plan_branch_pkey" PRIMARY KEY ("tenant_id","plan_id","branch_id")
);

-- CreateTable
CREATE TABLE "app"."coupon" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "app"."CouponKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "valid_from" DATE,
    "valid_to" DATE,
    "max_redemptions" INTEGER,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "plan_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "app"."CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."membership" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "app"."MembershipState" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "coupon_id" UUID,
    "renewed_from_id" UUID,
    "frozen_days" INTEGER NOT NULL DEFAULT 0,
    "freeze_count" INTEGER NOT NULL DEFAULT 0,
    "activated_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."membership_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "type" "app"."MembershipEventType" NOT NULL,
    "from_status" "app"."MembershipState",
    "to_status" "app"."MembershipState",
    "data" JSONB,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."membership_freeze" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_freeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invoice_series" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "app"."SeriesKind" NOT NULL,
    "series_key" TEXT NOT NULL,
    "financial_year" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."gym_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "membership_id" UUID,
    "number" TEXT NOT NULL,
    "document_type" "app"."InvoiceDocType" NOT NULL,
    "status" "app"."InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "prices_include_tax" BOOLEAN NOT NULL,
    "place_of_supply" TEXT,
    "taxable_minor" BIGINT NOT NULL,
    "cgst_minor" BIGINT NOT NULL DEFAULT 0,
    "sgst_minor" BIGINT NOT NULL DEFAULT 0,
    "igst_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "supplier" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "notes" TEXT,
    "pdf_file_id" UUID,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gym_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."gym_invoice_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "app"."InvoiceLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "sac_code" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "taxable_minor" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "cgst_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "sgst_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "igst_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "cgst_minor" BIGINT NOT NULL DEFAULT 0,
    "sgst_minor" BIGINT NOT NULL DEFAULT 0,
    "igst_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,

    CONSTRAINT "gym_invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."credit_note" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "taxable_minor" BIGINT NOT NULL,
    "cgst_minor" BIGINT NOT NULL DEFAULT 0,
    "sgst_minor" BIGINT NOT NULL DEFAULT 0,
    "igst_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."credit_note_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "taxable_minor" BIGINT NOT NULL,
    "cgst_minor" BIGINT NOT NULL DEFAULT 0,
    "sgst_minor" BIGINT NOT NULL DEFAULT 0,
    "igst_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,

    CONSTRAINT "credit_note_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."gym_payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "method" "app"."PaymentMethod" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reference" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "received_by_user_id" UUID,
    "status" "app"."PaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "receipt_number" TEXT NOT NULL,
    "proof_file_id" UUID,
    "notes" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "voided_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gym_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."payment_allocation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "source" "app"."AllocationSource" NOT NULL,
    "payment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_credit_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "kind" "app"."CreditEntryKind" NOT NULL,
    "payment_id" UUID,
    "invoice_id" UUID,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_credit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "member_id" UUID,
    "email" TEXT,
    "channel" "app"."NotificationChannel" NOT NULL,
    "category" "app"."NotificationCategory" NOT NULL,
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "status" "app"."DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "status_note" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."notification_preference" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "channel" "app"."NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("tenant_id","user_id","template_key","channel")
);

-- CreateTable
CREATE TABLE "app"."email_template" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_template_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "app"."data_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "app"."DataJobKind" NOT NULL,
    "status" "app"."DataJobStatus" NOT NULL DEFAULT 'PENDING',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "input_file_id" UUID,
    "result_file_id" UUID,
    "summary" JSONB,
    "params" JSONB,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "data_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_record_key_key" ON "app"."file_record"("key");

-- CreateIndex
CREATE INDEX "file_record_tenant_id_purpose_idx" ON "app"."file_record"("tenant_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "file_record_tenant_id_id_key" ON "app"."file_record"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "member_profile_tenant_id_status_idx" ON "app"."member_profile"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "member_profile_tenant_id_home_branch_id_idx" ON "app"."member_profile"("tenant_id", "home_branch_id");

-- CreateIndex
CREATE INDEX "member_profile_tenant_id_phone_idx" ON "app"."member_profile"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "member_profile_tenant_id_email_idx" ON "app"."member_profile"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "member_profile_tenant_id_id_key" ON "app"."member_profile"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_profile_tenant_id_member_code_key" ON "app"."member_profile"("tenant_id", "member_code");

-- CreateIndex
CREATE UNIQUE INDEX "member_profile_tenant_id_user_id_key" ON "app"."member_profile"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "member_note_tenant_id_member_id_created_at_idx" ON "app"."member_note"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE INDEX "member_document_tenant_id_member_id_idx" ON "app"."member_document"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "contact_consent_tenant_id_member_id_channel_purpose_capture_idx" ON "app"."contact_consent"("tenant_id", "member_id", "channel", "purpose", "captured_at");

-- CreateIndex
CREATE INDEX "membership_plan_tenant_id_status_idx" ON "app"."membership_plan"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "membership_plan_tenant_id_id_key" ON "app"."membership_plan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_plan_tenant_id_code_version_key" ON "app"."membership_plan"("tenant_id", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_tenant_id_id_key" ON "app"."coupon"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_tenant_id_code_key" ON "app"."coupon"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "membership_tenant_id_member_id_idx" ON "app"."membership"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "membership_tenant_id_status_end_date_idx" ON "app"."membership"("tenant_id", "status", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tenant_id_id_key" ON "app"."membership"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "membership_event_tenant_id_membership_id_created_at_idx" ON "app"."membership_event"("tenant_id", "membership_id", "created_at");

-- CreateIndex
CREATE INDEX "membership_freeze_tenant_id_membership_id_idx" ON "app"."membership_freeze"("tenant_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_tenant_id_kind_series_key_financial_year_key" ON "app"."invoice_series"("tenant_id", "kind", "series_key", "financial_year");

-- CreateIndex
CREATE INDEX "gym_invoice_tenant_id_member_id_idx" ON "app"."gym_invoice"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "gym_invoice_tenant_id_status_due_date_idx" ON "app"."gym_invoice"("tenant_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "gym_invoice_tenant_id_issue_date_idx" ON "app"."gym_invoice"("tenant_id", "issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "gym_invoice_tenant_id_id_key" ON "app"."gym_invoice"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gym_invoice_tenant_id_number_key" ON "app"."gym_invoice"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "gym_invoice_line_tenant_id_invoice_id_idx" ON "app"."gym_invoice_line"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "credit_note_tenant_id_invoice_id_idx" ON "app"."credit_note"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_tenant_id_id_key" ON "app"."credit_note"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_tenant_id_number_key" ON "app"."credit_note"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "credit_note_line_tenant_id_credit_note_id_idx" ON "app"."credit_note_line"("tenant_id", "credit_note_id");

-- CreateIndex
CREATE INDEX "gym_payment_tenant_id_member_id_idx" ON "app"."gym_payment"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "gym_payment_tenant_id_received_at_idx" ON "app"."gym_payment"("tenant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "gym_payment_tenant_id_id_key" ON "app"."gym_payment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gym_payment_tenant_id_receipt_number_key" ON "app"."gym_payment"("tenant_id", "receipt_number");

-- CreateIndex
CREATE INDEX "payment_allocation_tenant_id_invoice_id_idx" ON "app"."payment_allocation"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payment_allocation_tenant_id_payment_id_idx" ON "app"."payment_allocation"("tenant_id", "payment_id");

-- CreateIndex
CREATE INDEX "member_credit_entry_tenant_id_member_id_idx" ON "app"."member_credit_entry"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "notification_tenant_id_user_id_channel_read_at_idx" ON "app"."notification"("tenant_id", "user_id", "channel", "read_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_member_id_idx" ON "app"."notification"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenant_id_channel_dedupe_key_key" ON "app"."notification"("tenant_id", "channel", "dedupe_key");

-- CreateIndex
CREATE INDEX "data_job_tenant_id_created_at_idx" ON "app"."data_job"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "app"."tenant_counter" ADD CONSTRAINT "tenant_counter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."file_record" ADD CONSTRAINT "file_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_profile" ADD CONSTRAINT "member_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_profile" ADD CONSTRAINT "member_profile_tenant_id_home_branch_id_fkey" FOREIGN KEY ("tenant_id", "home_branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_note" ADD CONSTRAINT "member_note_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_document" ADD CONSTRAINT "member_document_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_document" ADD CONSTRAINT "member_document_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "app"."file_record"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."contact_consent" ADD CONSTRAINT "contact_consent_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership_plan" ADD CONSTRAINT "membership_plan_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."plan_branch" ADD CONSTRAINT "plan_branch_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "app"."membership_plan"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."plan_branch" ADD CONSTRAINT "plan_branch_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."coupon" ADD CONSTRAINT "coupon_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "app"."membership_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_tenant_id_coupon_id_fkey" FOREIGN KEY ("tenant_id", "coupon_id") REFERENCES "app"."coupon"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership_event" ADD CONSTRAINT "membership_event_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."membership_freeze" ADD CONSTRAINT "membership_freeze_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invoice_series" ADD CONSTRAINT "invoice_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_invoice" ADD CONSTRAINT "gym_invoice_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_invoice" ADD CONSTRAINT "gym_invoice_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_invoice" ADD CONSTRAINT "gym_invoice_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_invoice_line" ADD CONSTRAINT "gym_invoice_line_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "app"."gym_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."credit_note" ADD CONSTRAINT "credit_note_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "app"."gym_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."credit_note_line" ADD CONSTRAINT "credit_note_line_tenant_id_credit_note_id_fkey" FOREIGN KEY ("tenant_id", "credit_note_id") REFERENCES "app"."credit_note"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_payment" ADD CONSTRAINT "gym_payment_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_payment" ADD CONSTRAINT "gym_payment_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_allocation" ADD CONSTRAINT "payment_allocation_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "app"."gym_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_allocation" ADD CONSTRAINT "payment_allocation_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "app"."gym_payment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_credit_entry" ADD CONSTRAINT "member_credit_entry_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."notification_preference" ADD CONSTRAINT "notification_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."email_template" ADD CONSTRAINT "email_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."data_job" ADD CONSTRAINT "data_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
