-- CreateEnum
CREATE TYPE "app"."AiRequestOutcome" AS ENUM ('ANSWERED', 'FALLBACK', 'FLAGGED', 'ERROR');

-- AlterEnum
ALTER TYPE "app"."DataJobKind" ADD VALUE 'REPORT_EXPORT';

-- AlterTable
ALTER TABLE "app"."data_job" ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "kpi_grace_days" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "app"."metric_daily" (
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "active_members" INTEGER NOT NULL DEFAULT 0,
    "paused_members" INTEGER NOT NULL DEFAULT 0,
    "new_members" INTEGER NOT NULL DEFAULT 0,
    "check_ins" INTEGER NOT NULL DEFAULT 0,
    "unique_visits" INTEGER NOT NULL DEFAULT 0,
    "invoiced_minor" BIGINT NOT NULL DEFAULT 0,
    "payments_minor" BIGINT NOT NULL DEFAULT 0,
    "refunds_minor" BIGINT NOT NULL DEFAULT 0,
    "reconstructed" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_daily_pkey" PRIMARY KEY ("tenant_id","branch_id","day")
);

-- CreateTable
CREATE TABLE "platform"."ai_provider" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "label" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "api_key_sealed" TEXT,
    "api_key_hint" TEXT,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "max_tokens" INTEGER NOT NULL DEFAULT 800,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "supports_tools" BOOLEAN,
    "last_tested_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "last_test_message" TEXT,
    "log_retention_days" INTEGER NOT NULL DEFAULT 90,
    "tenant_rate_per_minute" INTEGER NOT NULL DEFAULT 6,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."ai_request_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "outcome" "app"."AiRequestOutcome" NOT NULL,
    "mode" TEXT NOT NULL,
    "model" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "ungrounded_numbers" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_daily_tenant_id_day_idx" ON "app"."metric_daily"("tenant_id", "day");

-- CreateIndex
CREATE INDEX "ai_request_log_tenant_id_created_at_idx" ON "app"."ai_request_log"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_request_log_tenant_id_id_key" ON "app"."ai_request_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "credit_note_tenant_id_issue_date_idx" ON "app"."credit_note"("tenant_id", "issue_date");

-- CreateIndex
CREATE INDEX "refund_tenant_id_processed_at_idx" ON "app"."refund"("tenant_id", "processed_at");

-- CreateIndex
CREATE INDEX "trial_booking_tenant_id_attended_at_idx" ON "app"."trial_booking"("tenant_id", "attended_at");

-- AddForeignKey
ALTER TABLE "app"."metric_daily" ADD CONSTRAINT "metric_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."metric_daily" ADD CONSTRAINT "metric_daily_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."ai_request_log" ADD CONSTRAINT "ai_request_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
