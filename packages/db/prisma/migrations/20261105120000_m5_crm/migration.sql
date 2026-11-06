-- CreateEnum
CREATE TYPE "app"."LeadStageCategory" AS ENUM ('NEW', 'CONTACTED', 'TRIAL_SCHEDULED', 'TRIAL_ATTENDED', 'OFFER_SENT', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "app"."LeadStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "app"."LeadActivityType" AS ENUM ('NOTE', 'CALL', 'EMAIL', 'MEETING', 'STAGE_CHANGE', 'ASSIGNMENT', 'TASK', 'TRIAL', 'CAPTURE', 'CONVERSION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "app"."FollowUpTaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."FollowUpTaskKind" AS ENUM ('FIRST_CONTACT', 'FOLLOW_UP', 'CALLBACK', 'TRIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "app"."TrialStatus" AS ENUM ('BOOKED', 'ATTENDED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."CampaignChannel" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'GOOGLE', 'WHATSAPP', 'SMS', 'EMAIL', 'WEBSITE', 'FLYER', 'REFERRAL', 'EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "app"."LeadAssignmentMode" AS ENUM ('MANUAL', 'ROUND_ROBIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "app"."DataJobKind" ADD VALUE 'LEAD_IMPORT';
ALTER TYPE "app"."DataJobKind" ADD VALUE 'LEAD_EXPORT';

-- AlterTable
ALTER TABLE "app"."membership" ADD COLUMN     "lead_id" UUID;

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "lead_assignment" "app"."LeadAssignmentMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "lead_first_contact_minutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "task_reminder_minutes" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "app"."lead_stage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "app"."LeadStageCategory" NOT NULL,
    "position" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead_source" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lost_reason" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_reason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."campaign" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "app"."CampaignChannel" NOT NULL,
    "code" TEXT NOT NULL,
    "starts_on" DATE,
    "ends_on" DATE,
    "budget_minor" BIGINT,
    "archived_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "interest" TEXT,
    "source_id" UUID,
    "campaign_id" UUID,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "referrer" TEXT,
    "first_touch" JSONB,
    "last_touch" JSONB,
    "stage_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "status" "app"."LeadStatus" NOT NULL DEFAULT 'OPEN',
    "score" INTEGER NOT NULL DEFAULT 0,
    "lost_reason_id" UUID,
    "lost_note" TEXT,
    "converted_member_id" UUID,
    "converted_membership_id" UUID,
    "capture_form_id" UUID,
    "consent_text" TEXT,
    "consent_at" TIMESTAMP(3),
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "first_contacted_at" TIMESTAMP(3),
    "last_contacted_at" TIMESTAMP(3),
    "sla_breached_at" TIMESTAMP(3),
    "won_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead_activity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "app"."LeadActivityType" NOT NULL,
    "body" TEXT,
    "meta" JSONB,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."follow_up_task" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "app"."FollowUpTaskKind" NOT NULL DEFAULT 'FOLLOW_UP',
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "due_at" TIMESTAMP(3) NOT NULL,
    "assignee_user_id" UUID,
    "status" "app"."FollowUpTaskStatus" NOT NULL DEFAULT 'OPEN',
    "lead_id" UUID,
    "member_id" UUID,
    "outcome" TEXT,
    "reminded_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trial_booking" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "class_session_id" UUID,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "trainer_user_id" UUID,
    "status" "app"."TrialStatus" NOT NULL DEFAULT 'BOOKED',
    "pass_code" TEXT NOT NULL,
    "notes" TEXT,
    "attended_at" TIMESTAMP(3),
    "attended_via" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead_capture_form" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "fields" TEXT[] DEFAULT ARRAY['email', 'interest']::TEXT[],
    "consent_text" TEXT NOT NULL,
    "marketing_text" TEXT,
    "thank_you" TEXT NOT NULL,
    "source_id" UUID,
    "campaign_id" UUID,
    "embed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archived_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_capture_form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."tenant_api_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "branch_id" UUID NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead_saved_view" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."lead_assignment_cursor" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "last_user_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_assignment_cursor_pkey" PRIMARY KEY ("tenant_id","branch_id")
);

-- CreateTable
CREATE TABLE "app"."event_consumption" (
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_consumption_pkey" PRIMARY KEY ("tenant_id","event_id","handler")
);

-- CreateIndex
CREATE INDEX "lead_stage_tenant_id_position_idx" ON "app"."lead_stage"("tenant_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lead_stage_tenant_id_id_key" ON "app"."lead_stage"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_tenant_id_id_key" ON "app"."lead_source"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_tenant_id_code_key" ON "app"."lead_source"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reason_tenant_id_id_key" ON "app"."lost_reason"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_tenant_id_id_key" ON "app"."campaign"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_tenant_id_code_key" ON "app"."campaign"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "lead_tenant_id_status_stage_id_idx" ON "app"."lead"("tenant_id", "status", "stage_id");

-- CreateIndex
CREATE INDEX "lead_tenant_id_branch_id_created_at_idx" ON "app"."lead"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_tenant_id_owner_user_id_status_idx" ON "app"."lead"("tenant_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "lead_tenant_id_phone_idx" ON "app"."lead"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "lead_tenant_id_email_idx" ON "app"."lead"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "lead_tenant_id_campaign_id_idx" ON "app"."lead"("tenant_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tenant_id_id_key" ON "app"."lead"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lead_activity_tenant_id_lead_id_created_at_idx" ON "app"."lead_activity"("tenant_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "follow_up_task_tenant_id_assignee_user_id_status_due_at_idx" ON "app"."follow_up_task"("tenant_id", "assignee_user_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "follow_up_task_tenant_id_status_due_at_idx" ON "app"."follow_up_task"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "follow_up_task_tenant_id_lead_id_idx" ON "app"."follow_up_task"("tenant_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_task_tenant_id_id_key" ON "app"."follow_up_task"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trial_booking_pass_code_key" ON "app"."trial_booking"("pass_code");

-- CreateIndex
CREATE INDEX "trial_booking_tenant_id_branch_id_starts_at_idx" ON "app"."trial_booking"("tenant_id", "branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "trial_booking_tenant_id_lead_id_idx" ON "app"."trial_booking"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "trial_booking_tenant_id_class_session_id_idx" ON "app"."trial_booking"("tenant_id", "class_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "trial_booking_tenant_id_id_key" ON "app"."trial_booking"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_capture_form_key_key" ON "app"."lead_capture_form"("key");

-- CreateIndex
CREATE UNIQUE INDEX "lead_capture_form_tenant_id_id_key" ON "app"."lead_capture_form"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_api_key_prefix_key" ON "app"."tenant_api_key"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_api_key_tenant_id_id_key" ON "app"."tenant_api_key"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lead_saved_view_tenant_id_user_id_idx" ON "app"."lead_saved_view"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_stage" ADD CONSTRAINT "lead_stage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_source" ADD CONSTRAINT "lead_source_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lost_reason" ADD CONSTRAINT "lost_reason_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."campaign" ADD CONSTRAINT "campaign_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_stage_id_fkey" FOREIGN KEY ("tenant_id", "stage_id") REFERENCES "app"."lead_stage"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_source_id_fkey" FOREIGN KEY ("tenant_id", "source_id") REFERENCES "app"."lead_source"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_campaign_id_fkey" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "app"."campaign"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_lost_reason_id_fkey" FOREIGN KEY ("tenant_id", "lost_reason_id") REFERENCES "app"."lost_reason"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_converted_member_id_fkey" FOREIGN KEY ("tenant_id", "converted_member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_converted_membership_id_fkey" FOREIGN KEY ("tenant_id", "converted_membership_id") REFERENCES "app"."membership"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead" ADD CONSTRAINT "lead_tenant_id_capture_form_id_fkey" FOREIGN KEY ("tenant_id", "capture_form_id") REFERENCES "app"."lead_capture_form"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_activity" ADD CONSTRAINT "lead_activity_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_up_task" ADD CONSTRAINT "follow_up_task_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_up_task" ADD CONSTRAINT "follow_up_task_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."follow_up_task" ADD CONSTRAINT "follow_up_task_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trial_booking" ADD CONSTRAINT "trial_booking_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trial_booking" ADD CONSTRAINT "trial_booking_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trial_booking" ADD CONSTRAINT "trial_booking_tenant_id_class_session_id_fkey" FOREIGN KEY ("tenant_id", "class_session_id") REFERENCES "app"."class_session"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_capture_form" ADD CONSTRAINT "lead_capture_form_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_capture_form" ADD CONSTRAINT "lead_capture_form_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_capture_form" ADD CONSTRAINT "lead_capture_form_tenant_id_source_id_fkey" FOREIGN KEY ("tenant_id", "source_id") REFERENCES "app"."lead_source"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_capture_form" ADD CONSTRAINT "lead_capture_form_tenant_id_campaign_id_fkey" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "app"."campaign"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tenant_api_key" ADD CONSTRAINT "tenant_api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tenant_api_key" ADD CONSTRAINT "tenant_api_key_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_saved_view" ADD CONSTRAINT "lead_saved_view_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."lead_assignment_cursor" ADD CONSTRAINT "lead_assignment_cursor_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."event_consumption" ADD CONSTRAINT "event_consumption_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
