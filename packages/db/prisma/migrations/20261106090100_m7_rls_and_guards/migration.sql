-- M7: row-level security for fitness, nutrition and engagement tables; append-only history;
-- value guards; the public referral-link lookup.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'health_data_consent', 'exercise', 'workout_template', 'workout_plan', 'workout_plan_version',
    'workout_log', 'set_log', 'personal_record', 'fitness_assessment', 'member_goal', 'food_item',
    'nutrition_plan', 'meal_plan_item', 'food_log', 'water_log', 'trainer_feedback', 'gym_announcement',
    'streak_state', 'achievement', 'member_achievement', 'challenge', 'challenge_participant',
    'reward_rule', 'reward_ledger', 'reward_perk', 'reward_redemption', 'referral_code', 'referral'
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

-- One active workout plan and one active nutrition plan per member.
CREATE UNIQUE INDEX workout_plan_one_active ON "app".workout_plan (tenant_id, member_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX nutrition_plan_one_active ON "app".nutrition_plan (tenant_id, member_id) WHERE status = 'ACTIVE';

-- Plausible values only (estimates, never negative; no reward without points).
ALTER TABLE "app".set_log ADD CONSTRAINT set_log_values CHECK (
  set_number BETWEEN 1 AND 50
  AND (reps IS NULL OR reps BETWEEN 0 AND 1000)
  AND (weight_kg IS NULL OR weight_kg BETWEEN 0 AND 1000)
  AND (duration_sec IS NULL OR duration_sec BETWEEN 0 AND 86400)
  AND (distance_m IS NULL OR distance_m BETWEEN 0 AND 200000));
ALTER TABLE "app".workout_log ADD CONSTRAINT workout_log_effort CHECK (effort IS NULL OR effort BETWEEN 1 AND 10);
ALTER TABLE "app".food_log ADD CONSTRAINT food_log_values CHECK (
  kcal >= 0 AND protein_g >= 0 AND carbs_g >= 0 AND fat_g >= 0 AND (portion_grams IS NULL OR portion_grams > 0));
ALTER TABLE "app".food_item ADD CONSTRAINT food_item_values CHECK (
  kcal_100 BETWEEN 0 AND 950 AND protein_100 BETWEEN 0 AND 100 AND carbs_100 BETWEEN 0 AND 100 AND fat_100 BETWEEN 0 AND 100
  AND (serving_grams IS NULL OR serving_grams > 0));
ALTER TABLE "app".water_log ADD CONSTRAINT water_log_ml CHECK (ml BETWEEN 1 AND 5000);
ALTER TABLE "app".challenge ADD CONSTRAINT challenge_values CHECK (target > 0 AND points >= 0 AND ends_on >= starts_on);
ALTER TABLE "app".reward_rule ADD CONSTRAINT reward_rule_points CHECK (points BETWEEN 0 AND 100000);
ALTER TABLE "app".reward_perk ADD CONSTRAINT reward_perk_cost CHECK (points_cost > 0);
ALTER TABLE "app".reward_redemption ADD CONSTRAINT reward_redemption_points CHECK (
  points > 0 AND (kind = 'PERK' OR amount_minor IS NOT NULL));
ALTER TABLE "app".reward_ledger ADD CONSTRAINT reward_ledger_sign CHECK (
  points <> 0 AND (kind <> 'EARN' OR points > 0) AND (kind <> 'REDEEM' OR points < 0));
ALTER TABLE "app".achievement ADD CONSTRAINT achievement_values CHECK (threshold > 0 AND points >= 0);
ALTER TABLE "app".referral_code ADD CONSTRAINT referral_code_format CHECK (code ~ '^[A-Z0-9]{6,12}$');
ALTER TABLE "app".tenant_settings ADD CONSTRAINT tenant_settings_m7_ranges CHECK (
  streak_visits_per_week BETWEEN 1 AND 7 AND streak_grace_days BETWEEN 0 AND 90
  AND reward_point_value_minor BETWEEN 0 AND 100000 AND reward_min_redeem_points >= 1
  AND reward_visit_weekly_cap BETWEEN 0 AND 7);

-- History is kept: consents, plan versions, PRs, points and earned achievements are append-only.
REVOKE UPDATE, DELETE ON "app".health_data_consent, "app".workout_plan_version, "app".personal_record,
  "app".reward_ledger, "app".member_achievement FROM gym_app;
-- Members may remove their own log lines (a wrong set, a food entry, a water tap) and trainers edit meal
-- lists; everything else is archived, ended or cancelled instead of deleted.
REVOKE DELETE ON "app".exercise, "app".workout_template, "app".workout_plan, "app".workout_log,
  "app".fitness_assessment, "app".member_goal, "app".food_item, "app".nutrition_plan, "app".trainer_feedback,
  "app".gym_announcement, "app".streak_state, "app".achievement, "app".challenge, "app".challenge_participant,
  "app".reward_rule, "app".reward_perk, "app".reward_redemption, "app".referral_code, "app".referral FROM gym_app;

-- ---------------------------------------------------------------------------------
-- Public referral link /r/<gym>/<code>: finds the gym and the referrer's first name before
-- anyone is signed in. Codes are random (no personal data); archived members' codes don't work.
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app".referral_lookup(p_slug text, p_code text)
  RETURNS TABLE (tenant_id uuid, member_id uuid, first_name text, gym_name text, branch_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, m.id, m.first_name, t.display_name, m.home_branch_id
    FROM "platform".tenant t
    JOIN "app".referral_code r ON r.tenant_id = t.id AND r.code = upper(p_code)
    JOIN "app".member_profile m ON m.tenant_id = r.tenant_id AND m.id = r.member_id
   WHERE t.slug = p_slug
     AND t.status = 'ACTIVE'
     AND m.status = 'ACTIVE'
     AND m.anonymized_at IS NULL
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION "app".referral_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".referral_lookup(text, text) TO gym_app;
