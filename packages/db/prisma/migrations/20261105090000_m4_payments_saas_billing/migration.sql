-- CreateEnum
CREATE TYPE "app"."PaymentProviderKind" AS ENUM ('RAZORPAY', 'FAKE');

-- CreateEnum
CREATE TYPE "app"."PaymentMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "app"."IntegrationStatus" AS ENUM ('ACTIVE', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "app"."PaymentLinkStatus" AS ENUM ('CREATED', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."PaymentLinkPurpose" AS ENUM ('INVOICES', 'BALANCE', 'RENEWAL', 'PURCHASE');

-- CreateEnum
CREATE TYPE "app"."WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "app"."RefundKind" AS ENUM ('ONLINE', 'MANUAL');

-- CreateEnum
CREATE TYPE "app"."RefundStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING', 'PROCESSED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "app"."ReconciliationKind" AS ENUM ('QUICK', 'DAILY', 'MANUAL');

-- CreateEnum
CREATE TYPE "app"."ReconciliationItemStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "app"."DataRequestKind" AS ENUM ('EXPORT', 'DELETION');

-- CreateEnum
CREATE TYPE "app"."DataRequestStatus" AS ENUM ('OPEN', 'DONE', 'REJECTED');

-- CreateEnum
CREATE TYPE "platform"."BillingCycle" AS ENUM ('MONTHLY', 'HALF_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "platform"."PlatformInvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "platform"."PlatformWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "platform"."AnnouncementAudience" AS ENUM ('ALL', 'PLANS', 'STATUSES');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "app"."CreditEntryKind" ADD VALUE 'ONLINE_REFUND';
ALTER TYPE "app"."CreditEntryKind" ADD VALUE 'REFUND_REVERSED';

-- AlterTable
ALTER TABLE "app"."gym_payment" ADD COLUMN     "payment_link_id" UUID,
ADD COLUMN     "provider_payment_id" TEXT;

-- AlterTable
ALTER TABLE "app"."member_profile" ADD COLUMN     "anonymized_at" TIMESTAMP(3),
ADD COLUMN     "privacy_accepted_at" TIMESTAMP(3),
ADD COLUMN     "privacy_notice_version" TEXT;

-- AlterTable
ALTER TABLE "app"."membership_plan" ADD COLUMN     "online_purchase" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "dues_reminder_days" INTEGER[] DEFAULT ARRAY[1, 7, 14, 30]::INTEGER[],
ADD COLUMN     "online_min_partial_minor" BIGINT NOT NULL DEFAULT 50000,
ADD COLUMN     "online_partial_allowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "payment_link_expiry_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "refund_approval_threshold_minor" BIGINT;

-- AlterTable
ALTER TABLE "platform"."tenant_subscription" ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "current_period_start" TIMESTAMP(3),
ADD COLUMN     "grace_ends_at" TIMESTAMP(3),
ADD COLUMN     "last_payment_at" TIMESTAMP(3),
ADD COLUMN     "past_due_at" TIMESTAMP(3),
ADD COLUMN     "pending_plan_id" UUID,
ADD COLUMN     "pending_price_id" UUID,
ADD COLUMN     "price_id" UUID,
ADD COLUMN     "provider_status" TEXT,
ADD COLUMN     "provider_subscription_id" TEXT;

-- CreateTable
CREATE TABLE "app"."payment_integration" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "app"."PaymentProviderKind" NOT NULL,
    "mode" "app"."PaymentMode" NOT NULL,
    "key_id" TEXT NOT NULL,
    "key_secret_enc" TEXT NOT NULL,
    "webhook_secret_enc" TEXT NOT NULL,
    "secret_last4" TEXT NOT NULL,
    "status" "app"."IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_verified_at" TIMESTAMP(3),
    "connected_by_id" UUID,
    "disconnected_at" TIMESTAMP(3),
    "disconnected_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."payment_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "reference_id" TEXT NOT NULL,
    "provider_link_id" TEXT,
    "purpose" "app"."PaymentLinkPurpose" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "accept_partial" BOOLEAN NOT NULL,
    "min_partial_minor" BIGINT,
    "status" "app"."PaymentLinkStatus" NOT NULL DEFAULT 'CREATED',
    "short_url" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."payment_link_invoice" (
    "tenant_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "payment_link_invoice_pkey" PRIMARY KEY ("tenant_id","link_id","invoice_id")
);

-- CreateTable
CREATE TABLE "app"."webhook_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "app"."WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."refund" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "app"."RefundKind" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "app"."RefundStatus" NOT NULL,
    "method" "app"."PaymentMethod",
    "reference" TEXT,
    "receipt" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "credit_note_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cancel_membership" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reconciliation_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "app"."ReconciliationKind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "checked" INTEGER NOT NULL DEFAULT 0,
    "fixed" INTEGER NOT NULL DEFAULT 0,
    "mismatches" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reconciliation_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "provider_id" TEXT,
    "issue" TEXT NOT NULL,
    "detail" JSONB,
    "status" "app"."ReconciliationItemStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_data_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "app"."DataRequestKind" NOT NULL,
    "status" "app"."DataRequestStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_data_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."saas_plan_price" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "cycle" "platform"."BillingCycle" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider_plan_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_plan_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_payment_account" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "key_secret_enc" TEXT NOT NULL,
    "webhook_secret_enc" TEXT NOT NULL,
    "secret_last4" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_verified_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_payment_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "supplier" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "taxable_minor" BIGINT NOT NULL,
    "cgst_minor" BIGINT NOT NULL DEFAULT 0,
    "sgst_minor" BIGINT NOT NULL DEFAULT 0,
    "igst_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "platform"."PlatformInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "provider_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID,
    "provider_payment_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "method" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_webhook_event" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "platform"."PlatformWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "platform_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."dunning_attempt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dunning_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."announcement" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "platform"."AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "plan_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statuses" "platform"."SubscriptionStatus"[] DEFAULT ARRAY[]::"platform"."SubscriptionStatus"[],
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_counter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_counter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_integration_tenant_id_id_key" ON "app"."payment_integration"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_link_reference_id_key" ON "app"."payment_link"("reference_id");

-- CreateIndex
CREATE INDEX "payment_link_tenant_id_status_idx" ON "app"."payment_link"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "payment_link_tenant_id_member_id_idx" ON "app"."payment_link"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_link_tenant_id_id_key" ON "app"."payment_link"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_link_tenant_id_provider_link_id_key" ON "app"."payment_link"("tenant_id", "provider_link_id");

-- CreateIndex
CREATE INDEX "webhook_event_tenant_id_status_received_at_idx" ON "app"."webhook_event"("tenant_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_tenant_id_id_key" ON "app"."webhook_event"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_integration_id_event_id_key" ON "app"."webhook_event"("integration_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_receipt_key" ON "app"."refund"("receipt");

-- CreateIndex
CREATE INDEX "refund_tenant_id_status_idx" ON "app"."refund"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "refund_tenant_id_payment_id_idx" ON "app"."refund"("tenant_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_tenant_id_id_key" ON "app"."refund"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "reconciliation_run_tenant_id_started_at_idx" ON "app"."reconciliation_run"("tenant_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_run_tenant_id_id_key" ON "app"."reconciliation_run"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "reconciliation_item_tenant_id_status_idx" ON "app"."reconciliation_item"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "member_data_request_tenant_id_status_idx" ON "app"."member_data_request"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "saas_plan_price_plan_id_cycle_key" ON "platform"."saas_plan_price"("plan_id", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoice_number_key" ON "platform"."platform_invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoice_provider_payment_id_key" ON "platform"."platform_invoice"("provider_payment_id");

-- CreateIndex
CREATE INDEX "platform_invoice_tenant_id_issue_date_idx" ON "platform"."platform_invoice"("tenant_id", "issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "platform_payment_provider_payment_id_key" ON "platform"."platform_payment"("provider_payment_id");

-- CreateIndex
CREATE INDEX "platform_payment_tenant_id_captured_at_idx" ON "platform"."platform_payment"("tenant_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_webhook_event_event_id_key" ON "platform"."platform_webhook_event"("event_id");

-- CreateIndex
CREATE INDEX "platform_webhook_event_status_received_at_idx" ON "platform"."platform_webhook_event"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "dunning_attempt_dedupe_key_key" ON "platform"."dunning_attempt"("dedupe_key");

-- CreateIndex
CREATE INDEX "dunning_attempt_tenant_id_sent_at_idx" ON "platform"."dunning_attempt"("tenant_id", "sent_at");

-- CreateIndex
CREATE INDEX "announcement_starts_at_idx" ON "platform"."announcement"("starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "gym_payment_tenant_id_provider_payment_id_key" ON "app"."gym_payment"("tenant_id", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscription_provider_subscription_id_key" ON "platform"."tenant_subscription"("provider_subscription_id");

-- AddForeignKey
ALTER TABLE "platform"."tenant_subscription" ADD CONSTRAINT "tenant_subscription_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "platform"."saas_plan_price"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_payment" ADD CONSTRAINT "gym_payment_tenant_id_payment_link_id_fkey" FOREIGN KEY ("tenant_id", "payment_link_id") REFERENCES "app"."payment_link"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_integration" ADD CONSTRAINT "payment_integration_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_link" ADD CONSTRAINT "payment_link_tenant_id_integration_id_fkey" FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "app"."payment_integration"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_link" ADD CONSTRAINT "payment_link_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_link" ADD CONSTRAINT "payment_link_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_link_invoice" ADD CONSTRAINT "payment_link_invoice_tenant_id_link_id_fkey" FOREIGN KEY ("tenant_id", "link_id") REFERENCES "app"."payment_link"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."payment_link_invoice" ADD CONSTRAINT "payment_link_invoice_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "app"."gym_invoice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."webhook_event" ADD CONSTRAINT "webhook_event_tenant_id_integration_id_fkey" FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "app"."payment_integration"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."refund" ADD CONSTRAINT "refund_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "app"."gym_payment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."refund" ADD CONSTRAINT "refund_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reconciliation_run" ADD CONSTRAINT "reconciliation_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reconciliation_item" ADD CONSTRAINT "reconciliation_item_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "app"."reconciliation_run"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_data_request" ADD CONSTRAINT "member_data_request_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_plan_price" ADD CONSTRAINT "saas_plan_price_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."saas_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_invoice" ADD CONSTRAINT "platform_invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_payment" ADD CONSTRAINT "platform_payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_payment" ADD CONSTRAINT "platform_payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform"."platform_invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."dunning_attempt" ADD CONSTRAINT "dunning_attempt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

