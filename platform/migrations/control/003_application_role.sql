-- 003_application_role.sql
--
-- The application connects as a non-owner, non-superuser, non-BYPASSRLS role so
-- that the policies in 002 actually apply (SPEC D1). No credential is stored
-- here: the password is deployment input, set outside migrations.
--
-- `ALTER DEFAULT PRIVILEGES` makes later migrations that add tables under
-- `agent_platform` grant this role automatically, as long as they run as the
-- same migration role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ontology_app') THEN
    CREATE ROLE ontology_app;
  END IF;
END
$$;

ALTER ROLE ontology_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOLOGIN;

GRANT USAGE ON SCHEMA agent_platform TO ontology_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_platform TO ontology_app;

DO $$
BEGIN
  IF to_regclass('agent_platform.control_schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON agent_platform.control_schema_migrations FROM ontology_app';
  END IF;
END
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA agent_platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ontology_app;
