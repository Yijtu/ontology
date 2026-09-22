-- 038_incremental_materialization.sql
--
-- Incremental materialisation, bitemporal projection and invalidation fence (SPEC D3.1/D5/D5.1,
-- ADR-13, US-016/US-017). `agent_platform.projection_state` (001) already carries the
-- generation/watermark/dirty row keyed by `projection_ref`; this migration adds the dirty reason
-- and the append-only projection-slice and invalidation-fence tables.
--
-- `projection_slices` is append-only across `(proposition, validity interval, recorded_seq)`:
-- a partial-interval correction appends a slice for its own interval and never rewrites the
-- slice of another interval. `materialization_fences` guards a read while an affected
-- recomputation is in flight so no stale conclusion is served.

ALTER TABLE agent_platform.projection_state
  ADD COLUMN IF NOT EXISTS dirty_reason text;

CREATE TABLE IF NOT EXISTS agent_platform.materialization_fences (
  tenant_id        uuid        NOT NULL,
  space_id         uuid        NOT NULL,
  projection_ref   text        NOT NULL,
  fence_id         uuid        NOT NULL,
  generation       bigint      NOT NULL,
  reason           text        NOT NULL,
  proposition_keys jsonb       NOT NULL DEFAULT '[]'::jsonb,
  state            text        NOT NULL DEFAULT 'open',
  opened_at        timestamptz NOT NULL,
  closed_at        timestamptz,
  CONSTRAINT materialization_fences_pkey PRIMARY KEY (tenant_id, space_id, fence_id),
  CONSTRAINT materialization_fences_state CHECK (state IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS materialization_fences_open_idx
  ON agent_platform.materialization_fences (tenant_id, space_id, state);

CREATE TABLE IF NOT EXISTS agent_platform.projection_slices (
  tenant_id                 uuid        NOT NULL,
  space_id                  uuid        NOT NULL,
  projection_ref            text        NOT NULL,
  slice_key                 text        NOT NULL,
  generation                bigint      NOT NULL,
  proposition_key           text        NOT NULL,
  qualified_proposition_key text        NOT NULL,
  predicate                 text        NOT NULL,
  domain_status             text        NOT NULL,
  value                     jsonb,
  valid_from                timestamptz NOT NULL,
  valid_to                  timestamptz,
  recorded_seq              text        NOT NULL,
  conclusion                jsonb       NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projection_slices_pkey PRIMARY KEY (tenant_id, space_id, slice_key)
);

CREATE INDEX IF NOT EXISTS projection_slices_lookup_idx
  ON agent_platform.projection_slices (tenant_id, space_id, projection_ref, proposition_key, valid_from);

ALTER TABLE agent_platform.materialization_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.projection_slices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.materialization_fences;
CREATE POLICY scope_isolation ON agent_platform.materialization_fences
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.projection_slices;
CREATE POLICY scope_isolation ON agent_platform.projection_slices
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
