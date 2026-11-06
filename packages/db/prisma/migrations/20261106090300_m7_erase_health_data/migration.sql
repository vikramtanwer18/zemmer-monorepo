-- M7: a member's deletion request also erases their health and fitness data (spec §13). The app role
-- can't delete these rows directly (history is append-only for everyday use), so erasure goes through
-- this one function, scoped to the current tenant. Consent records, points and earned milestones stay
-- (they hold no health data and document what happened).
CREATE OR REPLACE FUNCTION "app".erase_member_health_data(p_member_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t uuid := "app".current_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'no tenant in context';
  END IF;
  DELETE FROM "app".personal_record WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".set_log s USING "app".workout_log l
   WHERE s.tenant_id = t AND l.tenant_id = t AND s.log_id = l.id AND l.member_id = p_member_id;
  DELETE FROM "app".workout_log WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".workout_plan_version v USING "app".workout_plan p
   WHERE v.tenant_id = t AND p.tenant_id = t AND v.plan_id = p.id AND p.member_id = p_member_id;
  DELETE FROM "app".workout_plan WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".fitness_assessment WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".member_goal WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".food_log WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".water_log WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".meal_plan_item m USING "app".nutrition_plan n
   WHERE m.tenant_id = t AND n.tenant_id = t AND m.plan_id = n.id AND n.member_id = p_member_id;
  DELETE FROM "app".nutrition_plan WHERE tenant_id = t AND member_id = p_member_id;
  DELETE FROM "app".trainer_feedback WHERE tenant_id = t AND member_id = p_member_id;
  UPDATE "app".challenge_participant SET display_name = 'Former member', show_on_board = false
   WHERE tenant_id = t AND member_id = p_member_id;
END
$$;

REVOKE ALL ON FUNCTION "app".erase_member_health_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".erase_member_health_data(uuid) TO gym_app;
