-- CreateEnum
CREATE TYPE "app"."ExerciseMeasure" AS ENUM ('REPS', 'TIME', 'DISTANCE');

-- CreateEnum
CREATE TYPE "app"."FitnessLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "app"."WorkoutPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ENDED');

-- CreateEnum
CREATE TYPE "app"."WorkoutLogStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "app"."PersonalRecordKind" AS ENUM ('MAX_WEIGHT', 'EST_1RM', 'MAX_REPS', 'MAX_DURATION', 'MAX_DISTANCE');

-- CreateEnum
CREATE TYPE "app"."GoalType" AS ENUM ('WEIGHT', 'BODY_FAT', 'MEASUREMENT', 'STRENGTH', 'ATTENDANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "app"."GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "app"."MealSlot" AS ENUM ('BREAKFAST', 'MORNING_SNACK', 'LUNCH', 'EVENING_SNACK', 'DINNER', 'OTHER');

-- CreateEnum
CREATE TYPE "app"."FoodLogSource" AS ENUM ('LIBRARY', 'CUSTOM', 'PLAN');

-- CreateEnum
CREATE TYPE "app"."NutritionPlanStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "app"."FeedbackTarget" AS ENUM ('WORKOUT_LOG', 'ASSESSMENT', 'NUTRITION', 'GENERAL');

-- CreateEnum
CREATE TYPE "app"."MemberAudience" AS ENUM ('ALL', 'BRANCH', 'PLAN');

-- CreateEnum
CREATE TYPE "app"."StreakStatus" AS ENUM ('ACTIVE', 'FROZEN', 'BROKEN');

-- CreateEnum
CREATE TYPE "app"."AchievementKind" AS ENUM ('VISITS', 'WORKOUTS', 'PERSONAL_RECORDS', 'STREAK_WEEKS', 'CHALLENGES');

-- CreateEnum
CREATE TYPE "app"."ChallengeMetric" AS ENUM ('VISITS', 'WORKOUTS');

-- CreateEnum
CREATE TYPE "app"."ChallengeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "app"."RewardTrigger" AS ENUM ('VISIT', 'WORKOUT_COMPLETED', 'REFERRAL_CONVERTED', 'CHALLENGE_COMPLETED', 'ACHIEVEMENT');

-- CreateEnum
CREATE TYPE "app"."RewardEntryKind" AS ENUM ('EARN', 'REDEEM', 'REVERSE', 'ADJUST');

-- CreateEnum
CREATE TYPE "app"."RedemptionKind" AS ENUM ('CREDIT', 'PERK');

-- CreateEnum
CREATE TYPE "app"."RedemptionStatus" AS ENUM ('REQUESTED', 'FULFILLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "app"."ReferralStatus" AS ENUM ('PENDING', 'JOINED', 'REWARDED', 'REJECTED');

-- AlterTable
ALTER TABLE "app"."tenant_settings" ADD COLUMN     "reward_min_redeem_points" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "reward_point_value_minor" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "reward_visit_weekly_cap" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "streak_grace_days" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "streak_visits_per_week" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "app"."health_data_consent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "status" "app"."ConsentStatus" NOT NULL,
    "version" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "method" "app"."ConsentMethod" NOT NULL,
    "captured_by_user_id" UUID,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_data_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."exercise" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "library_key" TEXT,
    "name" TEXT NOT NULL,
    "primary_muscle" TEXT NOT NULL,
    "muscle_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "equipment" TEXT NOT NULL,
    "measure" "app"."ExerciseMeasure" NOT NULL DEFAULT 'REPS',
    "level" "app"."FitnessLevel" NOT NULL DEFAULT 'BEGINNER',
    "instructions" TEXT NOT NULL,
    "media_url" TEXT,
    "media_file_id" UUID,
    "custom" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."workout_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "level" "app"."FitnessLevel" NOT NULL DEFAULT 'BEGINNER',
    "structure" JSONB NOT NULL,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workout_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."workout_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "template_id" UUID,
    "trainer_user_id" UUID,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "app"."WorkoutPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workout_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."workout_plan_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "structure" JSONB NOT NULL,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workout_plan_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."workout_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "plan_id" UUID,
    "version_id" UUID,
    "day_key" TEXT,
    "title" TEXT NOT NULL,
    "status" "app"."WorkoutLogStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "performed_on" DATE NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "effort" INTEGER,
    "notes" TEXT,
    "created_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workout_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."set_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "log_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "plan_item_id" TEXT,
    "set_number" INTEGER NOT NULL,
    "reps" INTEGER,
    "weight_kg" DECIMAL(7,2),
    "duration_sec" INTEGER,
    "distance_m" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "set_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."personal_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "kind" "app"."PersonalRecordKind" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "previous" DECIMAL(10,2),
    "set_log_id" UUID NOT NULL,
    "log_id" UUID NOT NULL,
    "achieved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."fitness_assessment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "assessed_on" DATE NOT NULL,
    "metrics" JSONB NOT NULL,
    "notes" TEXT,
    "assessed_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fitness_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_goal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "type" "app"."GoalType" NOT NULL,
    "title" TEXT NOT NULL,
    "metric" TEXT,
    "unit" TEXT,
    "start_value" DECIMAL(10,2),
    "target_value" DECIMAL(10,2),
    "deadline" DATE,
    "status" "app"."GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "achieved_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."food_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "library_key" TEXT,
    "name" TEXT NOT NULL,
    "serving_name" TEXT,
    "serving_grams" INTEGER,
    "kcal_100" DECIMAL(7,1) NOT NULL,
    "protein_100" DECIMAL(6,1) NOT NULL,
    "carbs_100" DECIMAL(6,1) NOT NULL,
    "fat_100" DECIMAL(6,1) NOT NULL,
    "source" TEXT NOT NULL,
    "custom" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."nutrition_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "app"."NutritionPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "kcal_target" INTEGER,
    "protein_target" INTEGER,
    "carbs_target" INTEGER,
    "fat_target" INTEGER,
    "water_target_ml" INTEGER,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nutrition_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."meal_plan_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "slot" "app"."MealSlot" NOT NULL,
    "time" TEXT,
    "description" TEXT NOT NULL,
    "food_item_id" UUID,
    "portion_grams" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "meal_plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."food_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "logged_on" DATE NOT NULL,
    "slot" "app"."MealSlot" NOT NULL,
    "food_item_id" UUID,
    "name" TEXT NOT NULL,
    "portion_grams" DECIMAL(7,1),
    "kcal" DECIMAL(7,1) NOT NULL,
    "protein_g" DECIMAL(6,1) NOT NULL,
    "carbs_g" DECIMAL(6,1) NOT NULL,
    "fat_g" DECIMAL(6,1) NOT NULL,
    "source" "app"."FoodLogSource" NOT NULL,
    "assumptions" TEXT NOT NULL,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."water_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "logged_on" DATE NOT NULL,
    "ml" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "water_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."trainer_feedback" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "target" "app"."FeedbackTarget" NOT NULL,
    "target_id" UUID,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trainer_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."gym_announcement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "app"."MemberAudience" NOT NULL DEFAULT 'ALL',
    "branch_id" UUID,
    "plan_id" UUID,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "notified" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gym_announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."streak_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "current_weeks" INTEGER NOT NULL DEFAULT 0,
    "longest_weeks" INTEGER NOT NULL DEFAULT 0,
    "last_week_start" DATE,
    "status" "app"."StreakStatus" NOT NULL DEFAULT 'ACTIVE',
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "streak_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."achievement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "app"."AchievementKind" NOT NULL,
    "threshold" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."member_achievement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "achievement_id" UUID NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."challenge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metric" "app"."ChallengeMetric" NOT NULL,
    "target" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "branch_id" UUID,
    "leaderboard" BOOLEAN NOT NULL DEFAULT false,
    "points" INTEGER NOT NULL DEFAULT 0,
    "status" "app"."ChallengeStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."challenge_participant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "show_on_board" BOOLEAN NOT NULL DEFAULT true,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "challenge_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reward_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger" "app"."RewardTrigger" NOT NULL,
    "points" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reward_ledger" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "app"."RewardEntryKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "redemption_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reward_perk" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "points_cost" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_perk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."reward_redemption" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "app"."RedemptionKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "perk_id" UUID,
    "amount_minor" BIGINT,
    "credit_entry_id" UUID,
    "status" "app"."RedemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."referral_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."referral" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "referrer_member_id" UUID NOT NULL,
    "lead_id" UUID,
    "referred_member_id" UUID,
    "membership_id" UUID,
    "status" "app"."ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "joined_at" TIMESTAMP(3),
    "rewarded_at" TIMESTAMP(3),
    "reward_points" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "health_data_consent_tenant_id_member_id_captured_at_idx" ON "app"."health_data_consent"("tenant_id", "member_id", "captured_at");

-- CreateIndex
CREATE INDEX "exercise_tenant_id_primary_muscle_idx" ON "app"."exercise"("tenant_id", "primary_muscle");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_tenant_id_id_key" ON "app"."exercise"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_tenant_id_library_key_key" ON "app"."exercise"("tenant_id", "library_key");

-- CreateIndex
CREATE UNIQUE INDEX "workout_template_tenant_id_id_key" ON "app"."workout_template"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "workout_plan_tenant_id_member_id_status_idx" ON "app"."workout_plan"("tenant_id", "member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workout_plan_tenant_id_id_key" ON "app"."workout_plan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workout_plan_version_tenant_id_id_key" ON "app"."workout_plan_version"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workout_plan_version_tenant_id_plan_id_version_key" ON "app"."workout_plan_version"("tenant_id", "plan_id", "version");

-- CreateIndex
CREATE INDEX "workout_log_tenant_id_member_id_performed_on_idx" ON "app"."workout_log"("tenant_id", "member_id", "performed_on");

-- CreateIndex
CREATE UNIQUE INDEX "workout_log_tenant_id_id_key" ON "app"."workout_log"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "set_log_tenant_id_id_key" ON "app"."set_log"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "set_log_tenant_id_log_id_exercise_id_set_number_key" ON "app"."set_log"("tenant_id", "log_id", "exercise_id", "set_number");

-- CreateIndex
CREATE INDEX "personal_record_tenant_id_member_id_exercise_id_kind_achiev_idx" ON "app"."personal_record"("tenant_id", "member_id", "exercise_id", "kind", "achieved_at");

-- CreateIndex
CREATE UNIQUE INDEX "personal_record_tenant_id_id_key" ON "app"."personal_record"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "fitness_assessment_tenant_id_member_id_assessed_on_idx" ON "app"."fitness_assessment"("tenant_id", "member_id", "assessed_on");

-- CreateIndex
CREATE UNIQUE INDEX "fitness_assessment_tenant_id_id_key" ON "app"."fitness_assessment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "member_goal_tenant_id_member_id_status_idx" ON "app"."member_goal"("tenant_id", "member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "member_goal_tenant_id_id_key" ON "app"."member_goal"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "food_item_tenant_id_id_key" ON "app"."food_item"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "food_item_tenant_id_library_key_key" ON "app"."food_item"("tenant_id", "library_key");

-- CreateIndex
CREATE INDEX "nutrition_plan_tenant_id_member_id_status_idx" ON "app"."nutrition_plan"("tenant_id", "member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "nutrition_plan_tenant_id_id_key" ON "app"."nutrition_plan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meal_plan_item_tenant_id_id_key" ON "app"."meal_plan_item"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "food_log_tenant_id_member_id_logged_on_idx" ON "app"."food_log"("tenant_id", "member_id", "logged_on");

-- CreateIndex
CREATE UNIQUE INDEX "food_log_tenant_id_id_key" ON "app"."food_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "water_log_tenant_id_member_id_logged_on_idx" ON "app"."water_log"("tenant_id", "member_id", "logged_on");

-- CreateIndex
CREATE UNIQUE INDEX "water_log_tenant_id_id_key" ON "app"."water_log"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "trainer_feedback_tenant_id_member_id_created_at_idx" ON "app"."trainer_feedback"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trainer_feedback_tenant_id_id_key" ON "app"."trainer_feedback"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "gym_announcement_tenant_id_published_at_idx" ON "app"."gym_announcement"("tenant_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "gym_announcement_tenant_id_id_key" ON "app"."gym_announcement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "streak_state_tenant_id_id_key" ON "app"."streak_state"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "streak_state_tenant_id_member_id_key" ON "app"."streak_state"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_tenant_id_id_key" ON "app"."achievement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_tenant_id_key_key" ON "app"."achievement"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "member_achievement_tenant_id_id_key" ON "app"."member_achievement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_achievement_tenant_id_member_id_achievement_id_key" ON "app"."member_achievement"("tenant_id", "member_id", "achievement_id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_tenant_id_id_key" ON "app"."challenge"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participant_tenant_id_id_key" ON "app"."challenge_participant"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_participant_tenant_id_challenge_id_member_id_key" ON "app"."challenge_participant"("tenant_id", "challenge_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "reward_rule_tenant_id_id_key" ON "app"."reward_rule"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reward_rule_tenant_id_trigger_key" ON "app"."reward_rule"("tenant_id", "trigger");

-- CreateIndex
CREATE INDEX "reward_ledger_tenant_id_member_id_created_at_idx" ON "app"."reward_ledger"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reward_ledger_tenant_id_id_key" ON "app"."reward_ledger"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reward_ledger_tenant_id_source_key_key" ON "app"."reward_ledger"("tenant_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "reward_perk_tenant_id_id_key" ON "app"."reward_perk"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "reward_redemption_tenant_id_status_created_at_idx" ON "app"."reward_redemption"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reward_redemption_tenant_id_id_key" ON "app"."reward_redemption"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_code_tenant_id_id_key" ON "app"."referral_code"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_code_tenant_id_member_id_key" ON "app"."referral_code"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_code_tenant_id_code_key" ON "app"."referral_code"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "referral_tenant_id_referrer_member_id_idx" ON "app"."referral"("tenant_id", "referrer_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_tenant_id_id_key" ON "app"."referral"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_tenant_id_lead_id_key" ON "app"."referral"("tenant_id", "lead_id");

-- AddForeignKey
ALTER TABLE "app"."health_data_consent" ADD CONSTRAINT "health_data_consent_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."exercise" ADD CONSTRAINT "exercise_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_template" ADD CONSTRAINT "workout_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_plan" ADD CONSTRAINT "workout_plan_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_plan" ADD CONSTRAINT "workout_plan_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "app"."workout_template"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_plan_version" ADD CONSTRAINT "workout_plan_version_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "app"."workout_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_log" ADD CONSTRAINT "workout_log_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_log" ADD CONSTRAINT "workout_log_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "app"."workout_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."workout_log" ADD CONSTRAINT "workout_log_tenant_id_version_id_fkey" FOREIGN KEY ("tenant_id", "version_id") REFERENCES "app"."workout_plan_version"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."set_log" ADD CONSTRAINT "set_log_tenant_id_log_id_fkey" FOREIGN KEY ("tenant_id", "log_id") REFERENCES "app"."workout_log"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."set_log" ADD CONSTRAINT "set_log_tenant_id_exercise_id_fkey" FOREIGN KEY ("tenant_id", "exercise_id") REFERENCES "app"."exercise"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."personal_record" ADD CONSTRAINT "personal_record_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."personal_record" ADD CONSTRAINT "personal_record_tenant_id_exercise_id_fkey" FOREIGN KEY ("tenant_id", "exercise_id") REFERENCES "app"."exercise"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."personal_record" ADD CONSTRAINT "personal_record_tenant_id_set_log_id_fkey" FOREIGN KEY ("tenant_id", "set_log_id") REFERENCES "app"."set_log"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."personal_record" ADD CONSTRAINT "personal_record_tenant_id_log_id_fkey" FOREIGN KEY ("tenant_id", "log_id") REFERENCES "app"."workout_log"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."fitness_assessment" ADD CONSTRAINT "fitness_assessment_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_goal" ADD CONSTRAINT "member_goal_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."food_item" ADD CONSTRAINT "food_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."nutrition_plan" ADD CONSTRAINT "nutrition_plan_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."meal_plan_item" ADD CONSTRAINT "meal_plan_item_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "app"."nutrition_plan"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."meal_plan_item" ADD CONSTRAINT "meal_plan_item_tenant_id_food_item_id_fkey" FOREIGN KEY ("tenant_id", "food_item_id") REFERENCES "app"."food_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."food_log" ADD CONSTRAINT "food_log_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."food_log" ADD CONSTRAINT "food_log_tenant_id_food_item_id_fkey" FOREIGN KEY ("tenant_id", "food_item_id") REFERENCES "app"."food_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."water_log" ADD CONSTRAINT "water_log_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."trainer_feedback" ADD CONSTRAINT "trainer_feedback_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."gym_announcement" ADD CONSTRAINT "gym_announcement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."streak_state" ADD CONSTRAINT "streak_state_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."achievement" ADD CONSTRAINT "achievement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_achievement" ADD CONSTRAINT "member_achievement_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."member_achievement" ADD CONSTRAINT "member_achievement_tenant_id_achievement_id_fkey" FOREIGN KEY ("tenant_id", "achievement_id") REFERENCES "app"."achievement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."challenge" ADD CONSTRAINT "challenge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."challenge_participant" ADD CONSTRAINT "challenge_participant_tenant_id_challenge_id_fkey" FOREIGN KEY ("tenant_id", "challenge_id") REFERENCES "app"."challenge"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."challenge_participant" ADD CONSTRAINT "challenge_participant_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_rule" ADD CONSTRAINT "reward_rule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_ledger" ADD CONSTRAINT "reward_ledger_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_ledger" ADD CONSTRAINT "reward_ledger_tenant_id_redemption_id_fkey" FOREIGN KEY ("tenant_id", "redemption_id") REFERENCES "app"."reward_redemption"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_perk" ADD CONSTRAINT "reward_perk_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_redemption" ADD CONSTRAINT "reward_redemption_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."reward_redemption" ADD CONSTRAINT "reward_redemption_tenant_id_perk_id_fkey" FOREIGN KEY ("tenant_id", "perk_id") REFERENCES "app"."reward_perk"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."referral_code" ADD CONSTRAINT "referral_code_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."referral" ADD CONSTRAINT "referral_tenant_id_referrer_member_id_fkey" FOREIGN KEY ("tenant_id", "referrer_member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."referral" ADD CONSTRAINT "referral_tenant_id_referred_member_id_fkey" FOREIGN KEY ("tenant_id", "referred_member_id") REFERENCES "app"."member_profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."referral" ADD CONSTRAINT "referral_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "app"."lead"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
