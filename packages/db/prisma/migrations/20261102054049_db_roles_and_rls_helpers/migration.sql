-- Grants for the runtime roles (created by infra/postgres/01-roles.sql) and the tenant helper
-- used by every row-level security policy.
--
--   gym_owner     owns the tables; runs migrations and seeds only
--   gym_app       web + worker; schema "app", always filtered by RLS
--   gym_platform  admin; schema "platform" only, no access to gym data

-- Prisma only creates schemas that have models; make sure "app" exists.
CREATE SCHEMA IF NOT EXISTS "app";

-- gym_app: read/write the app schema.
GRANT USAGE ON SCHEMA "app" TO gym_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO gym_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "app" TO gym_app;

-- gym_platform: read/write the platform schema.
GRANT USAGE ON SCHEMA "platform" TO gym_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "platform" TO gym_platform;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "platform" TO gym_platform;

-- Tables and sequences created by future migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE gym_owner IN SCHEMA "app"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gym_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gym_owner IN SCHEMA "app"
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO gym_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gym_owner IN SCHEMA "platform"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gym_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE gym_owner IN SCHEMA "platform"
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO gym_platform;

-- The platform role never touches gym data.
REVOKE ALL ON SCHEMA "app" FROM gym_platform;
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM gym_platform;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "app" FROM gym_platform;

-- The tenant for the current transaction, set by withTenant() via
-- set_config('app.tenant_id', <uuid>, true). Returns NULL when unset or empty;
-- NULL matches no rows, so a forgotten tenant id shows nothing instead of everything.
CREATE OR REPLACE FUNCTION "app".current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

REVOKE ALL ON FUNCTION "app".current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app".current_tenant_id() TO gym_app;
