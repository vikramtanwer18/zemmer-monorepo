-- Runtime roles on RDS (run once as the RDS master user, before the first `pnpm db:deploy`).
-- Passwords are psql variables so they never land in a file or shell history:
--   psql "$MASTER_URL" -v app_pw="$APP_PW" -v platform_pw="$PLATFORM_PW" -v owner_pw="$OWNER_PW" -f infra/staging/roles.sql
-- gym_owner owns the schema and runs migrations; it is used only by the release step.

CREATE ROLE gym_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER CREATEROLE NOBYPASSRLS;
GRANT gym_owner TO CURRENT_USER;
CREATE ROLE gym_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE gym_platform LOGIN PASSWORD :'platform_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER DATABASE gym OWNER TO gym_owner;
GRANT CONNECT ON DATABASE gym TO gym_app, gym_platform;
