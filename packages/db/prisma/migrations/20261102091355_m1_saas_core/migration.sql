-- CreateEnum
CREATE TYPE "platform"."PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "platform"."PlatformUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "platform"."TenantStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "platform"."SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "platform"."FeatureType" AS ENUM ('BOOLEAN', 'QUOTA', 'CONFIG');

-- CreateEnum
CREATE TYPE "platform"."PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "platform"."SupportAccessMode" AS ENUM ('READ_ONLY');

-- CreateEnum
CREATE TYPE "app"."UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "app"."MembershipStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "app"."BranchStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "app"."InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "app"."AuditActorType" AS ENUM ('USER', 'SYSTEM', 'PLATFORM');

-- CreateEnum
CREATE TYPE "app"."OutboxStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "platform"."platform_user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "platform"."PlatformRole" NOT NULL DEFAULT 'SUPPORT',
    "status" "platform"."PlatformUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_session" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "mfa_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_account" (
    "id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_otp_challenge" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "platform"."TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."feature" (
    "key" TEXT NOT NULL,
    "type" "platform"."FeatureType" NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "default_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform"."saas_plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "platform"."PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "price_monthly_minor" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saas_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."plan_feature" (
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "value" JSONB,

    CONSTRAINT "plan_feature_pkey" PRIMARY KEY ("plan_id","feature_key")
);

-- CreateTable
CREATE TABLE "platform"."tenant_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "platform"."SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trial_ends_at" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."subscription_override" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "value" JSONB,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."usage_counter" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "platform"."platform_audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "tenant_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform"."support_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "mode" "platform"."SupportAccessMode" NOT NULL DEFAULT 'READ_ONLY',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "app"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."session" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "active_tenant_id" UUID,
    "active_branch_id" UUID,
    "mfa_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."account" (
    "id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."otp_challenge" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trusted_device" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."tenant_membership" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "app"."MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."role_assignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_key" TEXT NOT NULL,
    "branch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."branch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state_code" TEXT NOT NULL,
    "postal_code" TEXT,
    "phone" TEXT,
    "timezone" TEXT,
    "gstin" TEXT,
    "status" "app"."BranchStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "roles" JSONB NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "app"."InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_user_id" UUID,
    "invited_by_platform_user_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "accepted_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "gst_registered" BOOLEAN NOT NULL DEFAULT false,
    "gstin" TEXT,
    "state_code" TEXT,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT true,
    "require_2fa_for_staff" BOOLEAN NOT NULL DEFAULT false,
    "logo_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "app"."audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" "app"."AuditActorType" NOT NULL,
    "actor_user_id" UUID,
    "actor_platform_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "branch_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "app"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."idempotency_record" (
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("tenant_id","scope","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform"."platform_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_session_token_key" ON "platform"."platform_session"("token");

-- CreateIndex
CREATE INDEX "platform_session_user_id_idx" ON "platform"."platform_session"("user_id");

-- CreateIndex
CREATE INDEX "platform_account_user_id_idx" ON "platform"."platform_account"("user_id");

-- CreateIndex
CREATE INDEX "platform_verification_identifier_idx" ON "platform"."platform_verification"("identifier");

-- CreateIndex
CREATE INDEX "platform_otp_challenge_session_id_created_at_idx" ON "platform"."platform_otp_challenge"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "platform"."tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "platform"."tenant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "saas_plan_code_version_key" ON "platform"."saas_plan"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscription_tenant_id_key" ON "platform"."tenant_subscription"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_subscription_status_trial_ends_at_idx" ON "platform"."tenant_subscription"("status", "trial_ends_at");

-- CreateIndex
CREATE INDEX "subscription_override_tenant_id_feature_key_idx" ON "platform"."subscription_override"("tenant_id", "feature_key");

-- CreateIndex
CREATE INDEX "platform_audit_log_created_at_idx" ON "platform"."platform_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_tenant_id_created_at_idx" ON "platform"."platform_audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_action_idx" ON "platform"."platform_audit_log"("action");

-- CreateIndex
CREATE INDEX "support_session_tenant_id_expires_at_idx" ON "platform"."support_session"("tenant_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "app"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "app"."session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "app"."session"("user_id");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "app"."account"("user_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "app"."verification"("identifier");

-- CreateIndex
CREATE INDEX "otp_challenge_session_id_created_at_idx" ON "app"."otp_challenge"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_device_token_hash_key" ON "app"."trusted_device"("token_hash");

-- CreateIndex
CREATE INDEX "trusted_device_user_id_idx" ON "app"."trusted_device"("user_id");

-- CreateIndex
CREATE INDEX "tenant_membership_user_id_idx" ON "app"."tenant_membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_membership_tenant_id_user_id_key" ON "app"."tenant_membership"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_membership_tenant_id_id_key" ON "app"."tenant_membership"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "role_assignment_tenant_id_membership_id_idx" ON "app"."role_assignment"("tenant_id", "membership_id");

-- CreateIndex
CREATE INDEX "branch_tenant_id_status_idx" ON "app"."branch"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "branch_tenant_id_code_key" ON "app"."branch"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "branch_tenant_id_id_key" ON "app"."branch"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "app"."invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_tenant_id_status_idx" ON "app"."invitation"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "invitation_tenant_id_email_idx" ON "app"."invitation"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "app"."audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_action_idx" ON "app"."audit_log"("tenant_id", "action");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_idx" ON "app"."audit_log"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "outbox_tenant_id_status_idx" ON "app"."outbox"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "outbox_status_available_at_idx" ON "app"."outbox"("status", "available_at");

-- AddForeignKey
ALTER TABLE "platform"."platform_session" ADD CONSTRAINT "platform_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_account" ADD CONSTRAINT "platform_account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_otp_challenge" ADD CONSTRAINT "platform_otp_challenge_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "platform"."platform_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."plan_feature" ADD CONSTRAINT "plan_feature_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."saas_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."plan_feature" ADD CONSTRAINT "plan_feature_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "platform"."feature"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."tenant_subscription" ADD CONSTRAINT "tenant_subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."tenant_subscription" ADD CONSTRAINT "tenant_subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."saas_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."subscription_override" ADD CONSTRAINT "subscription_override_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."subscription_override" ADD CONSTRAINT "subscription_override_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "platform"."feature"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."usage_counter" ADD CONSTRAINT "usage_counter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."platform_audit_log" ADD CONSTRAINT "platform_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "platform"."platform_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_session" ADD CONSTRAINT "support_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."support_session" ADD CONSTRAINT "support_session_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform"."platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."otp_challenge" ADD CONSTRAINT "otp_challenge_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app"."session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trusted_device" ADD CONSTRAINT "trusted_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tenant_membership" ADD CONSTRAINT "tenant_membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tenant_membership" ADD CONSTRAINT "tenant_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "app"."tenant_membership"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "app"."branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."branch" ADD CONSTRAINT "branch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation" ADD CONSTRAINT "invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."idempotency_record" ADD CONSTRAINT "idempotency_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
