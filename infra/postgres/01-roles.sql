-- Runs once, when the Postgres volume is first created (and in CI via psql).
-- Two runtime login roles. Neither can bypass row-level security.
-- Development passwords only; production roles are created separately with real secrets.

CREATE ROLE gym_app LOGIN PASSWORD 'gym_app_dev_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE gym_platform LOGIN PASSWORD 'gym_platform_dev_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE gym TO gym_app, gym_platform;







