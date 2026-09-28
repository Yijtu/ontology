-- Immutable JEV state references are authorized for one canonical run/profile.
-- The artifact bytes remain in the content-addressed blob store.
CREATE TABLE agent_platform.decision_state_refs (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resolved_profile_hash text NOT NULL,
  state_ref_id uuid NOT NULL,
  state_ref_version text NOT NULL,
  state_ref_digest text NOT NULL,
  state_ref_kind text NOT NULL,
  state_ref jsonb NOT NULL,
  registered_at timestamptz NOT NULL,
  CONSTRAINT decision_state_refs_pkey PRIMARY KEY
    (tenant_id, space_id, run_id, state_ref_id, state_ref_version, state_ref_kind),
  CONSTRAINT decision_state_refs_run_fkey FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE,
  CONSTRAINT decision_state_refs_profile_hash CHECK (resolved_profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT decision_state_refs_ref_shape CHECK (
    COALESCE(
      state_ref_kind = 'artifact'
    AND jsonb_typeof(state_ref) = 'object'
    AND jsonb_typeof(state_ref->'id') = 'string'
    AND state_ref->>'id' = state_ref_id::text
    AND jsonb_typeof(state_ref->'version') = 'string'
    AND state_ref->>'version' = state_ref_version
    AND jsonb_typeof(state_ref->'digest') = 'string'
    AND state_ref->>'digest' = state_ref_digest
    AND state_ref->>'kind' = 'artifact'
      AND state_ref_digest ~ '^sha256:[0-9a-f]{64}$',
      false
    )
  )
);

CREATE INDEX decision_state_refs_run_profile_idx
  ON agent_platform.decision_state_refs (tenant_id, space_id, run_id, resolved_profile_hash);

ALTER TABLE agent_platform.decision_state_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON agent_platform.decision_state_refs
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

-- Semantic review status is answer metadata, separate from the hash-bound business body.
ALTER TABLE agent_platform.answer_publications
  ADD COLUMN semantic_review jsonb;

ALTER TABLE agent_platform.answer_publications
  ADD CONSTRAINT answer_publications_semantic_review_shape CHECK (
    semantic_review IS NULL OR (
      jsonb_typeof(semantic_review) = 'object'
      AND COALESCE(semantic_review->>'status' IN ('completed', 'not_run'), false)
      AND (
        semantic_review->>'status' = 'completed'
        OR COALESCE(semantic_review->>'reason' IN ('disabled', 'no_claims', 'not_configured', 'provider_fallback'), false)
      )
    )
  );
