-- 066_published_pack_assets.sql
--
-- Immutable industry-pack publication and the persistent dynamic catalogue (SPEC v0.3a
-- asset-data-ui §3.1/§4.2/§6.1; issue V03-015 / #187; A.US-005, P.US-005/006/011, P.FR-14/15/17).
--
-- Design:
--  * `published_pack_assets` is the persistent dynamic catalogue. Each row is one immutable pack
--    version: the human-reviewed draft published in one control transaction together with its
--    definition version, workspace publish pointer and outbox message. A new pack is queryable and
--    re-mountable from this table, so a runtime publication never depends on a restart or on
--    editing the static example list (A.ADR-04).
--  * `content_digest` pins the declaration content; `(tenant_id, space_id, namespace, version)` is
--    unique, so two different packs can never publish the same namespace+version with different
--    content. `(tenant_id, space_id, pack_id, version)` is the pack identity and a same id/version
--    with a different digest is refused.
--  * `(tenant_id, space_id, idempotency_key)` is the claim on publication: replaying the same key
--    returns the stored row; the same key with a different `request_digest` is an idempotency
--    conflict.
--  * `asset` holds the full immutable `PublishedPackAsset` (manifest, source index, capability
--    state, version diff); it is declaration data only and never carries a customer instance, real
--    price table, identity decision or credential.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside the session scope
-- and the table carries a `scope_isolation` policy. Forward-only: 001..065 are never edited.
--
-- NOTE: migration numbering is coordinated; 058-065 and 067 are taken by parallel work.
--
-- The atomic publication also enqueues its `asset.pack.published` outbox message, which requires a
-- `jobs` anchor row (job_outbox has a foreign key to jobs). Extend the jobs kind check with the
-- dedicated `asset_publication` kind rather than mislabelling the row as ingestion/simulation.

ALTER TABLE agent_platform.jobs DROP CONSTRAINT IF EXISTS jobs_kind;
ALTER TABLE agent_platform.jobs ADD CONSTRAINT jobs_kind
  CHECK (kind IN ('ingestion', 'simulation', 'asset_publication'));

CREATE TABLE IF NOT EXISTS agent_platform.published_pack_assets (
  tenant_id            uuid        NOT NULL,
  space_id             uuid        NOT NULL,
  pack_id              text        NOT NULL,
  version              text        NOT NULL,
  namespace            text        NOT NULL,
  maturity             text        NOT NULL,
  definition_id        text        NOT NULL,
  definition_version   text        NOT NULL,
  definition_digest    text        NOT NULL,
  content_digest       text        NOT NULL,
  revision             bigint      NOT NULL,
  origin_workspace_id  uuid        NOT NULL,
  asset                jsonb       NOT NULL,
  idempotency_key      text        NOT NULL,
  request_digest       text        NOT NULL,
  actor                text        NOT NULL,
  trace_id             text,
  published_at         timestamptz NOT NULL,
  CONSTRAINT published_pack_assets_pkey PRIMARY KEY (tenant_id, space_id, pack_id, version),
  CONSTRAINT published_pack_assets_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT published_pack_assets_namespace_version_unique UNIQUE (tenant_id, space_id, namespace, version),
  CONSTRAINT published_pack_assets_workspace_fkey FOREIGN KEY (tenant_id, space_id, origin_workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT published_pack_assets_pack_id_nonempty CHECK (char_length(pack_id) > 0),
  CONSTRAINT published_pack_assets_version_nonempty CHECK (char_length(version) > 0),
  CONSTRAINT published_pack_assets_namespace_nonempty CHECK (char_length(namespace) > 0),
  CONSTRAINT published_pack_assets_maturity CHECK (maturity IN ('planned', 'preview', 'stable', 'deprecated')),
  CONSTRAINT published_pack_assets_revision_positive CHECK (revision > 0),
  CONSTRAINT published_pack_assets_definition_digest_format CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT published_pack_assets_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT published_pack_assets_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT published_pack_assets_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT published_pack_assets_asset_object CHECK (jsonb_typeof(asset) = 'object')
);

CREATE INDEX IF NOT EXISTS published_pack_assets_namespace_idx
  ON agent_platform.published_pack_assets (tenant_id, space_id, namespace, published_at);

CREATE INDEX IF NOT EXISTS published_pack_assets_definition_idx
  ON agent_platform.published_pack_assets (tenant_id, space_id, definition_id, definition_version);

ALTER TABLE agent_platform.published_pack_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.published_pack_assets;
CREATE POLICY scope_isolation ON agent_platform.published_pack_assets
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
