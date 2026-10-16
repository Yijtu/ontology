-- 101_tool_settings_migration_records.sql
--
-- Durable idempotency for the one-time legacy `CORE_WEB_SEARCH_*` bridge (S03, design §10).
--
-- The bridge imports a compat-gateway connection + space assignment once per scope. A local marker
-- file is not authoritative: if it is lost (new host, moved data directory, changed user), a later
-- start would re-import the environment *after* the catalogue was edited in the UI, silently
-- restoring the environment as a second source of truth. This table records, once per
-- (tenant, space, migration_key), that the bridge ran, so the marker is durable and consultable.
--
-- Forward-only; appended after 100; earlier migrations are never edited. Every key carries
-- tenant_id/space_id and the table has a `scope_isolation` RLS policy.

CREATE TABLE IF NOT EXISTS agent_platform.core_tool_settings_migrations (
  tenant_id     uuid        NOT NULL,
  space_id      uuid        NOT NULL,
  migration_key text        NOT NULL,
  detail        jsonb       NOT NULL,
  migrated_at   timestamptz NOT NULL,
  CONSTRAINT core_tool_settings_migrations_pkey PRIMARY KEY (tenant_id, space_id, migration_key),
  CONSTRAINT core_tool_settings_migrations_key_length CHECK (char_length(migration_key) BETWEEN 1 AND 200),
  CONSTRAINT core_tool_settings_migrations_detail_object CHECK (jsonb_typeof(detail) = 'object')
);

ALTER TABLE agent_platform.core_tool_settings_migrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.core_tool_settings_migrations;
CREATE POLICY scope_isolation ON agent_platform.core_tool_settings_migrations
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
