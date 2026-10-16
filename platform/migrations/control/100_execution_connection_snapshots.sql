-- 100_execution_connection_snapshots.sql
--
-- Immutable, non-secret execution-config snapshots for pinned model/tool connections (design §9,
-- node S02).
--
-- Why this exists: until now an `execution_model_bindings`/`execution_tool_bindings` row recorded
-- only the connection id and its revision, while the runtime rebuilt the adapter/provider from
-- today's `model_connections`/`tool_connections` row. Editing that row (endpoint, protocol, provider
-- model, adapter, strategy) therefore silently retargeted every in-flight execution. This table
-- stores the exact non-secret config a revision was pinned with, so the binding can reference it and
-- the current catalogue is consulted *only* for the revoke/disable/permission fence.
--
-- Design:
--  * One row per (kind, connection_id, revision). `kind` is `tool` or `model`; both catalogues share
--    the shape, so one table stores either snapshot.
--  * The row is append-only and write-once per revision: a revision that already has a snapshot is
--    never rewritten (`ON CONFLICT DO NOTHING` in the store), so a pinned config cannot change under
--    a running execution. `snapshot_digest` is the SHA-256 of the canonical snapshot JSON, so a
--    reader can detect a snapshot that was replaced rather than edited.
--  * The snapshot **never** contains a credential: a key is an opaque `credential_ref` the host
--    custodian resolves, so rotation/revocation stay in custody (a cleared/revoked credential blocks
--    through the binding fence, never by rewriting the snapshot).
--
-- Forward-only: migrations 001..099 are never edited. Every key carries tenant_id/space_id and the
-- table has a `scope_isolation` RLS policy (migration 002 shape).

CREATE TABLE IF NOT EXISTS agent_platform.execution_connection_snapshots (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  kind            text        NOT NULL,
  connection_id   uuid        NOT NULL,
  revision        bigint      NOT NULL,
  snapshot        jsonb       NOT NULL,
  snapshot_digest text        NOT NULL,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT execution_connection_snapshots_pkey
    PRIMARY KEY (tenant_id, space_id, kind, connection_id, revision),
  CONSTRAINT execution_connection_snapshots_kind CHECK (kind IN ('tool', 'model')),
  CONSTRAINT execution_connection_snapshots_revision_positive CHECK (revision >= 1),
  CONSTRAINT execution_connection_snapshots_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT execution_connection_snapshots_digest_format CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS execution_connection_snapshots_scope_idx
  ON agent_platform.execution_connection_snapshots (tenant_id, space_id, kind, connection_id, revision DESC);

ALTER TABLE agent_platform.execution_connection_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.execution_connection_snapshots;
CREATE POLICY scope_isolation ON agent_platform.execution_connection_snapshots
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
