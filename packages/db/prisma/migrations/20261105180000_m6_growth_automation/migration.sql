-- CreateEnum
CREATE TYPE "app"."WhatsAppConnectionMethod" AS ENUM ('MANUAL', 'EMBEDDED_SIGNUP', 'FAKE');

-- CreateEnum
CREATE TYPE "app"."WhatsAppAccountStatus" AS ENUM ('ACTIVE', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "app"."TemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "app"."SuppressionReason" AS ENUM ('OPT_OUT', 'BLOCKED', 'BOUNCED', 'MANUAL');

-- CreateEnum
CREATE TYPE "app"."MessageKind" AS ENUM ('TEMPLATE', 'TEXT');

-- CreateEnum
CREATE TYPE "app"."MessagePurpose" AS ENUM ('CAMPAIGN', 'AUTOMATION', 'NOTIFICATION', 'INBOX', 'TEST');

-- CreateEnum
CREATE TYPE "app"."OutboundStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."MessageEventKind" AS ENUM ('STATUS', 'INBOUND', 'TEMPLATE_STATUS');

-- CreateEnum
CREATE TYPE "app"."MessageEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "app"."SegmentEntity" AS ENUM ('MEMBER', 'LEAD');

-- CreateEnum
CREATE TYPE "app"."CampaignSendStatus" AS ENUM ('NONE', 'DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."CampaignRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."AutomationExecutionStatus" AS ENUM ('RUNNING', 'WAITING', 'AWAITING_APPROVAL', 'COMPLETED', 'EXITED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."AutomationStepStatus" AS ENUM ('DONE', 'SKIPPED', 'FAILED', 'WAITING');

-- CreateEnum
CREATE TYPE "app"."RetentionRuleKind" AS ENUM ('NO_VISIT', 'VISIT_DROP', 'EXPIRING', 'OVERDUE', 'UNUSED_CREDITS', 'TRIAL_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "app"."RetentionFlagStatus" AS ENUM ('OPEN', 'ACTIONED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "app"."RecoveryKind" AS ENUM ('RENEWED', 'PAID', 'REACTIVATED', 'CONVERTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "app"."ConsentMethod" ADD VALUE 'WEB_FORM';
ALTER TYPE "app"."ConsentMethod" ADD VALUE 'API';
ALTER TYPE "app"."ConsentMethod" ADD VALUE 'INBOUND_KEYWORD';

-- AlterTable
ALTER TABLE "app"."campaign" ADD COLUMN     "attribution_days" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "estimated_recipients" INTEGER,
ADD COLUMN     "launched_at" TIMESTAMP(3),
ADD COLUMN     "launched_by_id" UUID,
ADD COLUMN     "scheduled_at" TIMESTAMP(3),
ADD COLUMN     "segment_id" UUID,
ADD COLUMN     "send_status" "app"."CampaignSendStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "template_id" UUID,
ADD COLUMN     "throttle_per_minute" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "variable_map" JSONB;

-- AlterTable
ALTER TABLE "app"."contact_consent" ADD COLUMN     "lead_id" UUID,
ALTER COLUMN "member_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "marketing_daily_cap" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "opt_in_keywords" TEXT[] DEFAULT ARRAY['start', 'subscribe', 'shuru', 'chalu']::TEXT[],
ADD COLUMN     "opt_out_keywords" TEXT[] DEFAULT ARRAY['stop', 'unsubscribe', 'stop all', 'cancel', 'end', 'quit', 'opt out', 'optout', 'band karo', 'band', 'rok do', 'mat bhejo', 'nahi chahiye', 'बंद', 'बंद करो', 'रोको']::TEXT[],
ADD COLUMN     "whatsapp_notification_templates" JSONB;

-- CreateTable
CREATE TABLE "app"."whatsapp_account" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone" TEXT,
    "verified_name" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "token_last4" TEXT NOT NULL,
    "connection_method" "app"."WhatsAppConnectionMethod" NOT NULL,
    "status" "app"."WhatsAppAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "quality_rating" TEXT,
    "messaging_limit" TEXT,
    "webhook_subscribed" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_by_id" UUID,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."message_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider_template_id" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "app"."TemplateCategory" NOT NULL,
    "status" TEXT NOT NULL,
    "parameter_format" TEXT NOT NULL DEFAULT 'POSITIONAL',
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body_text" TEXT,
    "components" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."suppression_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel" "app"."ConsentChannel" NOT NULL,
    "address" TEXT NOT NULL,
    "reason" "app"."SuppressionReason" NOT NULL,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMP(3),
    "lifted_by_id" UUID,

    CONSTRAINT "suppression_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."conversation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "profile_name" TEXT,
    "member_id" UUID,
    "lead_id" UUID,
    "assignee_user_id" UUID,
    "last_inbound_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "unread" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."inbound_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "keyword" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."outbound_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "conversation_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "member_id" UUID,
    "lead_id" UUID,
    "kind" "app"."MessageKind" NOT NULL,
    "template_id" UUID,
    "template_name" TEXT,
    "language" TEXT,
    "variables" JSONB,
    "body" TEXT,
    "category" "app"."TemplateCategory" NOT NULL,
    "purpose" "app"."MessagePurpose" NOT NULL,
    "status" "app"."OutboundStatus" NOT NULL DEFAULT 'QUEUED',
    "skip_reason" TEXT,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "pricing_category" TEXT,
    "campaign_id" UUID,
    "execution_id" UUID,
    "created_by_id" UUID,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."message_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" "app"."MessageEventKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "app"."MessageEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "message_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."segment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity" "app"."SegmentEntity" NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."campaign_recipient" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "member_id" UUID,
    "lead_id" UUID,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "status" "app"."CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "skip_reason" TEXT,
    "variables" JSONB,
    "outbound_message_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."automation_workflow" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_key" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "current_version_id" UUID,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."automation_workflow_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."automation_execution" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "trigger_key" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "member_id" UUID,
    "lead_id" UUID,
    "context" JSONB NOT NULL,
    "status" "app"."AutomationExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "next_step" INTEGER NOT NULL DEFAULT 0,
    "resume_at" TIMESTAMP(3),
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "automation_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."automation_step_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" "app"."AutomationStepStatus" NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "automation_step_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."retention_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "app"."RetentionRuleKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "threshold" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."retention_flag" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "member_id" UUID,
    "lead_id" UUID,
    "kind" "app"."RetentionRuleKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "status" "app"."RetentionFlagStatus" NOT NULL DEFAULT 'OPEN',
    "action" TEXT,
    "actioned_at" TIMESTAMP(3),
    "actioned_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."recovery_outcome" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "app"."RecoveryKind" NOT NULL,
    "member_id" UUID,
    "lead_id" UUID,
    "flag_id" UUID,
    "campaign_id" UUID,
    "execution_id" UUID,
    "ref_id" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_account_phone_number_id_idx" ON "app"."whatsapp_account"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_account_waba_id_idx" ON "app"."whatsapp_account"("waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_account_tenant_id_id_key" ON "app"."whatsapp_account"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_template_tenant_id_id_key" ON "app"."message_template"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_template_tenant_id_account_id_name_language_key" ON "app"."message_template"("tenant_id", "account_id", "name", "language");

-- CreateIndex
CREATE INDEX "suppression_record_tenant_id_channel_address_idx" ON "app"."suppression_record"("tenant_id", "channel", "address");

-- CreateIndex
CREATE INDEX "conversation_tenant_id_last_message_at_idx" ON "app"."conversation"("tenant_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tenant_id_id_key" ON "app"."conversation"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tenant_id_account_id_phone_key" ON "app"."conversation"("tenant_id", "account_id", "phone");

-- CreateIndex
CREATE INDEX "inbound_message_tenant_id_conversation_id_received_at_idx" ON "app"."inbound_message"("tenant_id", "conversation_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_message_tenant_id_provider_message_id_key" ON "app"."inbound_message"("tenant_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "outbound_message_tenant_id_status_queued_at_idx" ON "app"."outbound_message"("tenant_id", "status", "queued_at");

-- CreateIndex
CREATE INDEX "outbound_message_tenant_id_member_id_queued_at_idx" ON "app"."outbound_message"("tenant_id", "member_id", "queued_at");

-- CreateIndex
CREATE INDEX "outbound_message_tenant_id_campaign_id_idx" ON "app"."outbound_message"("tenant_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_message_tenant_id_id_key" ON "app"."outbound_message"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_message_tenant_id_idempotency_key_key" ON "app"."outbound_message"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_message_tenant_id_provider_message_id_key" ON "app"."outbound_message"("tenant_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "message_event_tenant_id_status_received_at_idx" ON "app"."message_event"("tenant_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_event_tenant_id_id_key" ON "app"."message_event"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_event_tenant_id_dedupe_key_key" ON "app"."message_event"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "segment_tenant_id_id_key" ON "app"."segment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "campaign_recipient_tenant_id_campaign_id_status_idx" ON "app"."campaign_recipient"("tenant_id", "campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipient_tenant_id_id_key" ON "app"."campaign_recipient"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipient_tenant_id_campaign_id_phone_key" ON "app"."campaign_recipient"("tenant_id", "campaign_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "automation_workflow_tenant_id_id_key" ON "app"."automation_workflow"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_workflow_version_tenant_id_id_key" ON "app"."automation_workflow_version"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_workflow_version_tenant_id_workflow_id_version_key" ON "app"."automation_workflow_version"("tenant_id", "workflow_id", "version");

-- CreateIndex
CREATE INDEX "automation_execution_tenant_id_status_resume_at_idx" ON "app"."automation_execution"("tenant_id", "status", "resume_at");

-- CreateIndex
CREATE INDEX "automation_execution_tenant_id_workflow_id_started_at_idx" ON "app"."automation_execution"("tenant_id", "workflow_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_execution_tenant_id_id_key" ON "app"."automation_execution"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_execution_tenant_id_version_id_trigger_key_key" ON "app"."automation_execution"("tenant_id", "version_id", "trigger_key");

-- CreateIndex
CREATE UNIQUE INDEX "automation_step_run_tenant_id_execution_id_step_index_key" ON "app"."automation_step_run"("tenant_id", "execution_id", "step_index");

-- CreateIndex
CREATE UNIQUE INDEX "retention_rule_tenant_id_kind_key" ON "app"."retention_rule"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "retention_flag_tenant_id_status_kind_idx" ON "app"."retention_flag"("tenant_id", "status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "retention_flag_tenant_id_id_key" ON "app"."retention_flag"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "recovery_outcome_tenant_id_occurred_at_idx" ON "app"."recovery_outcome"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_outcome_tenant_id_kind_ref_id_key" ON "app"."recovery_outcome"("tenant_id", "kind", "ref_id");

-- AddForeignKey
ALTER TABLE "app"."contact_consent" ADD CONSTRAINT "contact_consent_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."campaign" ADD CONSTRAINT "campaign_tenant_id_segment_id_fkey" FOREIGN KEY ("tenant_id", "segment_id") REFERENCES "app"."segment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."whatsapp_account" ADD CONSTRAINT "whatsapp_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."message_template" ADD CONSTRAINT "message_template_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "app"."whatsapp_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."suppression_record" ADD CONSTRAINT "suppression_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."conversation" ADD CONSTRAINT "conversation_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "app"."whatsapp_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."conversation" ADD CONSTRAINT "conversation_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."conversation" ADD CONSTRAINT "conversation_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."inbound_message" ADD CONSTRAINT "inbound_message_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "app"."conversation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."outbound_message" ADD CONSTRAINT "outbound_message_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "app"."whatsapp_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."outbound_message" ADD CONSTRAINT "outbound_message_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "app"."conversation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."outbound_message" ADD CONSTRAINT "outbound_message_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "app"."message_template"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."message_event" ADD CONSTRAINT "message_event_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "app"."whatsapp_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."segment" ADD CONSTRAINT "segment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."campaign_recipient" ADD CONSTRAINT "campaign_recipient_tenant_id_campaign_id_fkey" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "app"."campaign"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."campaign_recipient" ADD CONSTRAINT "campaign_recipient_tenant_id_outbound_message_id_fkey" FOREIGN KEY ("tenant_id", "outbound_message_id") REFERENCES "app"."outbound_message"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."automation_workflow" ADD CONSTRAINT "automation_workflow_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."automation_workflow_version" ADD CONSTRAINT "automation_workflow_version_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "app"."automation_workflow"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."automation_execution" ADD CONSTRAINT "automation_execution_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "app"."automation_workflow"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."automation_execution" ADD CONSTRAINT "automation_execution_tenant_id_version_id_fkey" FOREIGN KEY ("tenant_id", "version_id") REFERENCES "app"."automation_workflow_version"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."automation_step_run" ADD CONSTRAINT "automation_step_run_tenant_id_execution_id_fkey" FOREIGN KEY ("tenant_id", "execution_id") REFERENCES "app"."automation_execution"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."retention_rule" ADD CONSTRAINT "retention_rule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."retention_flag" ADD CONSTRAINT "retention_flag_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."recovery_outcome" ADD CONSTRAINT "recovery_outcome_tenant_id_flag_id_fkey" FOREIGN KEY ("tenant_id", "flag_id") REFERENCES "app"."retention_flag"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
