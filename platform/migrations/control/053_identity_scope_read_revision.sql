-- 053_identity_scope_read_revision.sql
--
-- Monotonic identity read head and immutable cluster-scope provenance. The identity
-- counter advances in the same transaction as each accepted decision; readers never
-- infer a revision from timestamps or MAX(cluster revision).

ALTER TABLE agent_platform.identity_entities
  ADD COLUMN IF NOT EXISTS scope_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_from_candidate_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'identity_entities_scope_dimensions_object'
       AND conrelid = 'agent_platform.identity_entities'::regclass
  ) THEN
    ALTER TABLE agent_platform.identity_entities
      ADD CONSTRAINT identity_entities_scope_dimensions_object
      CHECK (jsonb_typeof(scope_dimensions) = 'object');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_platform.identity_scope_read_heads (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  CONSTRAINT identity_scope_read_heads_pkey PRIMARY KEY (tenant_id, space_id),
  CONSTRAINT identity_scope_read_heads_revision_non_negative CHECK (revision >= 0)
);

CREATE INDEX IF NOT EXISTS identity_link_constraints_candidate_idx
  ON agent_platform.identity_link_constraints (tenant_id, space_id, candidate_id, entity_id);

ALTER TABLE agent_platform.identity_scope_read_heads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.identity_scope_read_heads;
CREATE POLICY scope_isolation ON agent_platform.identity_scope_read_heads
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
