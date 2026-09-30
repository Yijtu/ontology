-- 069_project_document_index.sql
--
-- Project document corpus membership, visibility epochs and BM25 index receipts
-- (SPEC v0.3a asset-data-ui §7, issue V03-019 / #191).
--
-- Why these tables exist on top of the existing keyword index (020) and project
-- revision/readiness (058/067):
--
--  * The indexed corpus of a project is a fixed DocumentSet of *authorised active
--    memberships and complete parse refs* — never a whole-space `listParses`. A
--    membership row records exactly which original/parse/text revision belongs to
--    `collectionRef = project:<projectId>`.
--  * A revision/retraction must move index visibility. `project_visibility`
--    carries a per-project monotonic `visibility_epoch`; every membership state
--    change and every replacement bumps it. A document_search reads the epoch at
--    the start and again before returning, and a build that finished under an
--    older epoch can never reactivate a withdrawn corpus because the receipt CAS
--    in this table refuses a stale epoch.
--  * `project_document_index_receipts` records the exact (generation,
--    visibility_epoch, membership_revision, corpus digest) a successful build
--    verified. Search trusts `ready` only when the active generation has a receipt
--    whose epoch matches the current project epoch.
--  * Memberships are append-only per `(document_id, membership_revision)`; a
--    retraction/replacement appends a new revision instead of erasing history, so
--    an archived span stays readable while being explicitly marked current-withdrawn.
--
-- `keyword_index_generation_counters` replaces the `Number(max)+1` generation
-- allocation (which raced and lost precision) with a scope+collection bigint
-- counter row locked in the builder's write transaction.
--
-- Every table carries tenant_id/space_id, has RLS enabled and a `scope_isolation`
-- policy. Appended after 067, so the schema default privileges grant the
-- application role. Forward-only: migrations 001..067 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.project_visibility (
  tenant_id          uuid        NOT NULL,
  space_id           uuid        NOT NULL,
  project_id         uuid        NOT NULL,
  visibility_epoch   bigint      NOT NULL DEFAULT 0,
  membership_revision bigint     NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_visibility_pkey PRIMARY KEY (tenant_id, space_id, project_id),
  CONSTRAINT project_visibility_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_visibility_epoch_non_negative CHECK (visibility_epoch >= 0),
  CONSTRAINT project_visibility_membership_non_negative CHECK (membership_revision >= 0)
);

CREATE TABLE IF NOT EXISTS agent_platform.project_document_memberships (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  document_id         uuid        NOT NULL,
  membership_revision bigint      NOT NULL,
  state               text        NOT NULL,
  document_ref        jsonb       NOT NULL,
  document_digest     text        NOT NULL,
  parse_id            uuid        NOT NULL,
  parse_ref           jsonb       NOT NULL,
  text_digest         text        NOT NULL,
  precision           text        NOT NULL,
  source_namespace    text,
  source_id           text,
  visibility_epoch    bigint      NOT NULL,
  replaced_by         uuid,
  reason              text,
  recorded_at         timestamptz NOT NULL,
  CONSTRAINT project_document_memberships_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, document_id, membership_revision),
  CONSTRAINT project_document_memberships_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_document_memberships_state
    CHECK (state IN ('active', 'retracted', 'replaced')),
  CONSTRAINT project_document_memberships_revision_positive CHECK (membership_revision > 0),
  -- 0 is allowed so a project's first epoch (a membership registered before any
  -- revision) can be recorded, but a negative epoch is a bug.
  CONSTRAINT project_document_memberships_epoch_non_negative CHECK (visibility_epoch >= 0),
  CONSTRAINT project_document_memberships_document_digest_format
    CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_document_memberships_text_digest_format
    CHECK (text_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_document_memberships_precision
    CHECK (precision IN ('exact', 'approximate')),
  CONSTRAINT project_document_memberships_document_ref_object
    CHECK (jsonb_typeof(document_ref) = 'object'),
  CONSTRAINT project_document_memberships_parse_ref_object
    CHECK (jsonb_typeof(parse_ref) = 'object')
);

-- The current state of one document is its highest membership_revision; the
-- active corpus is that set filtered to `state = 'active'`.
CREATE INDEX IF NOT EXISTS project_document_memberships_current_idx
  ON agent_platform.project_document_memberships
    (tenant_id, space_id, project_id, document_id, membership_revision DESC);

CREATE INDEX IF NOT EXISTS project_document_memberships_active_idx
  ON agent_platform.project_document_memberships
    (tenant_id, space_id, project_id, parse_id)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS agent_platform.project_document_index_receipts (
  tenant_id             uuid        NOT NULL,
  space_id              uuid        NOT NULL,
  project_id            uuid        NOT NULL,
  collection_ref        text        NOT NULL,
  generation            text        NOT NULL,
  visibility_epoch      bigint      NOT NULL,
  membership_revision   bigint      NOT NULL,
  target_digest         text        NOT NULL,
  index_ref             jsonb       NOT NULL,
  doc_count             bigint      NOT NULL,
  source_document_count bigint      NOT NULL,
  completeness          text        NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT project_document_index_receipts_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, collection_ref, generation),
  CONSTRAINT project_document_index_receipts_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_document_index_receipts_generation_format
    CHECK (generation ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT project_document_index_receipts_epoch_non_negative CHECK (visibility_epoch >= 0),
  CONSTRAINT project_document_index_receipts_membership_non_negative CHECK (membership_revision >= 0),
  CONSTRAINT project_document_index_receipts_target_digest_format
    CHECK (target_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_document_index_receipts_doc_count_non_negative CHECK (doc_count >= 0),
  CONSTRAINT project_document_index_receipts_source_count_non_negative CHECK (source_document_count >= 0),
  CONSTRAINT project_document_index_receipts_completeness
    CHECK (completeness IN ('complete', 'partial', 'truncated', 'unknown')),
  CONSTRAINT project_document_index_receipts_index_ref_object
    CHECK (jsonb_typeof(index_ref) = 'object')
);

-- Resolving the receipt for the one active generation of a collection is the hot
-- read on the search path.
CREATE INDEX IF NOT EXISTS project_document_index_receipts_active_idx
  ON agent_platform.project_document_index_receipts
    (tenant_id, space_id, project_id, collection_ref, generation);

CREATE TABLE IF NOT EXISTS agent_platform.keyword_index_generation_counters (
  tenant_id      uuid        NOT NULL,
  space_id       uuid        NOT NULL,
  collection_ref text        NOT NULL,
  counter        bigint      NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keyword_index_generation_counters_pkey PRIMARY KEY
    (tenant_id, space_id, collection_ref),
  CONSTRAINT keyword_index_generation_counters_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT keyword_index_generation_counters_non_negative CHECK (counter >= 0)
);

ALTER TABLE agent_platform.project_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.project_document_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.project_document_index_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.keyword_index_generation_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_visibility;
CREATE POLICY scope_isolation ON agent_platform.project_visibility
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_document_memberships;
CREATE POLICY scope_isolation ON agent_platform.project_document_memberships
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_document_index_receipts;
CREATE POLICY scope_isolation ON agent_platform.project_document_index_receipts
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.keyword_index_generation_counters;
CREATE POLICY scope_isolation ON agent_platform.keyword_index_generation_counters
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
