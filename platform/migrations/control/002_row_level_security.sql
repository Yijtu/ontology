-- 002_row_level_security.sql
--
-- Row-Level Security as defence in depth behind the application scope filter
-- (SPEC D1). The non-owner application role sets the trusted scope with
-- `set_config('app.tenant_id', ..., true)` inside its transaction.
--
-- An unset or empty setting resolves to NULL, so the predicate is never true and
-- a connection that has not established a scope can neither read nor write
-- tenant rows. The table owner (migration role) bypasses RLS, which is why
-- migrations and administrative seeding run as the owner and the application
-- runs as a separate NOLOGIN-capable, non-owner role (see 003).

ALTER TABLE agent_platform.tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.spaces          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.event_streams   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.semantic_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.projection_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON agent_platform.tenants;
CREATE POLICY tenant_isolation ON agent_platform.tenants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS scope_isolation ON agent_platform.spaces;
CREATE POLICY scope_isolation ON agent_platform.spaces
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.event_streams;
CREATE POLICY scope_isolation ON agent_platform.event_streams
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.semantic_events;
CREATE POLICY scope_isolation ON agent_platform.semantic_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.projection_state;
CREATE POLICY scope_isolation ON agent_platform.projection_state
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
