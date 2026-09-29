-- 058_industry_workspace_project_revisions.sql
--
-- Industry-workspace draft head, immutable project revisions and append-only
-- field-confirmation events (SPEC v0.3a asset-data-ui §3.1/§3.2/§3.3/§4.1,
-- issue V03-003 / #174).
--
-- Design:
--  * `industry_workspaces` is the mutable draft head of an industry workspace.
--    `(tenant_id, space_id, workspace_id)` is the durable identity; `namespace`
--    is deliberately NOT globally unique, because two customers may model the
--    same industry namespace in their own scope. `head_revision` is the
--    compare-and-swap counter behind If-Match; every draft append locks this row
--    `FOR UPDATE`, so two concurrent appends cannot both pass the same
--    `expectedRevision` and the loser is a VERSION_CONFLICT.
--  * `asset_draft_versions` is append-only: each revision is an immutable row and
--    `(workspace_id, revision)` is unique. The `idempotency_key` is unique per
--    scope, so a replayed append returns the original draft instead of writing a
--    second one; `request_digest` distinguishes a retry from IDEMPOTENCY_CONFLICT.
--  * `projects` mirrors `industry_workspaces` for customer projects.
--  * `project_revisions` is append-only and fixed: a changed field, document,
--    mapping or industry version appends a new revision; readiness is a separate
--    projection and is never back-filled into a revision. `source_visibility_epoch`
--    and `change_reason` are stamped at append time.
--  * `field_confirmation_events` is the append-only input-governance history. A
--    confirmation is a new row keyed by `(record_id, field_id, revision)`, so a
--    correction never rewrites the earlier decision.
--  * The workspace/project stores write the transactional outbox row into the
--    existing `job_outbox` in the same transaction as the state change.
--
-- Every key and foreign key carries tenant_id/space_id, RLS denies rows outside
-- the session scope and each tenant-owned table carries a `scope_isolation`
-- policy. Appended after 003, so the schema default privileges grant the
-- application role. Forward-only: migrations 001..056 are never edited.

CREATE TABLE IF NOT EXISTS agent_platform.industry_workspaces (
  tenant_id              uuid        NOT NULL,
  space_id               uuid        NOT NULL,
  workspace_id           uuid        NOT NULL,
  namespace              text        NOT NULL,
  display_name           text        NOT NULL,
  boundary               jsonb       NOT NULL,
  head_revision          bigint      NOT NULL DEFAULT 1,
  state                  text        NOT NULL DEFAULT 'draft',
  latest_pack_ref        jsonb,
  create_idempotency_key text        NOT NULL,
  create_request_digest  text        NOT NULL,
  created_by             text        NOT NULL,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CONSTRAINT industry_workspaces_pkey PRIMARY KEY (tenant_id, space_id, workspace_id),
  CONSTRAINT industry_workspaces_create_key_unique UNIQUE (tenant_id, space_id, create_idempotency_key),
  CONSTRAINT industry_workspaces_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT industry_workspaces_head_positive CHECK (head_revision >= 1),
  CONSTRAINT industry_workspaces_state CHECK (state IN ('draft', 'review', 'published', 'archived')),
  CONSTRAINT industry_workspaces_display_name_nonempty CHECK (char_length(display_name) > 0),
  CONSTRAINT industry_workspaces_namespace_nonempty CHECK (char_length(namespace) > 0),
  CONSTRAINT industry_workspaces_create_digest_format CHECK (create_request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT industry_workspaces_boundary_object CHECK (jsonb_typeof(boundary) = 'object'),
  CONSTRAINT industry_workspaces_pack_ref_object CHECK (latest_pack_ref IS NULL OR jsonb_typeof(latest_pack_ref) = 'object'),
  CONSTRAINT industry_workspaces_create_key_length CHECK (char_length(create_idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS industry_workspaces_scope_idx
  ON agent_platform.industry_workspaces (tenant_id, space_id, state, updated_at, workspace_id);

CREATE INDEX IF NOT EXISTS industry_workspaces_namespace_idx
  ON agent_platform.industry_workspaces (tenant_id, space_id, namespace);

CREATE TABLE IF NOT EXISTS agent_platform.asset_draft_versions (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  workspace_id    uuid        NOT NULL,
  revision        bigint      NOT NULL,
  digest          text        NOT NULL,
  body            jsonb       NOT NULL,
  document_set_ref jsonb      NOT NULL,
  idempotency_key text        NOT NULL,
  request_digest  text        NOT NULL,
  outbox_id       uuid,
  actor           text        NOT NULL,
  trace_id        text,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT asset_draft_versions_pkey PRIMARY KEY (tenant_id, space_id, workspace_id, revision),
  CONSTRAINT asset_draft_versions_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT asset_draft_versions_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT asset_draft_versions_revision_positive CHECK (revision > 0),
  CONSTRAINT asset_draft_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_draft_versions_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT asset_draft_versions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT asset_draft_versions_document_set_object CHECK (jsonb_typeof(document_set_ref) = 'object'),
  CONSTRAINT asset_draft_versions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS asset_draft_versions_revision_idx
  ON agent_platform.asset_draft_versions (tenant_id, space_id, workspace_id, revision DESC);

CREATE TABLE IF NOT EXISTS agent_platform.projects (
  tenant_id              uuid        NOT NULL,
  space_id               uuid        NOT NULL,
  project_id             uuid        NOT NULL,
  title                  text        NOT NULL,
  head_revision          bigint      NOT NULL DEFAULT 1,
  state                  text        NOT NULL DEFAULT 'draft',
  create_idempotency_key text        NOT NULL,
  create_request_digest  text        NOT NULL,
  created_by             text        NOT NULL,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CONSTRAINT projects_pkey PRIMARY KEY (tenant_id, space_id, project_id),
  CONSTRAINT projects_create_key_unique UNIQUE (tenant_id, space_id, create_idempotency_key),
  CONSTRAINT projects_space_fkey FOREIGN KEY (tenant_id, space_id)
    REFERENCES agent_platform.spaces (tenant_id, space_id) ON DELETE CASCADE,
  CONSTRAINT projects_head_positive CHECK (head_revision >= 1),
  CONSTRAINT projects_state CHECK (state IN ('draft', 'active', 'archived')),
  CONSTRAINT projects_title_nonempty CHECK (char_length(title) > 0),
  CONSTRAINT projects_create_digest_format CHECK (create_request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT projects_create_key_length CHECK (char_length(create_idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS projects_scope_idx
  ON agent_platform.projects (tenant_id, space_id, state, updated_at, project_id);

CREATE TABLE IF NOT EXISTS agent_platform.project_revisions (
  tenant_id               uuid        NOT NULL,
  space_id                uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  revision                bigint      NOT NULL,
  digest                  text        NOT NULL,
  body                    jsonb       NOT NULL,
  source_visibility_epoch bigint      NOT NULL,
  change_reason           text        NOT NULL,
  idempotency_key         text        NOT NULL,
  request_digest          text        NOT NULL,
  outbox_id               uuid,
  actor                   text        NOT NULL,
  trace_id                text,
  recorded_at             timestamptz NOT NULL,
  CONSTRAINT project_revisions_pkey PRIMARY KEY (tenant_id, space_id, project_id, revision),
  CONSTRAINT project_revisions_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT project_revisions_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT project_revisions_revision_positive CHECK (revision > 0),
  CONSTRAINT project_revisions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_revisions_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_revisions_epoch_non_negative CHECK (source_visibility_epoch >= 0),
  CONSTRAINT project_revisions_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT project_revisions_change_reason_nonempty CHECK (char_length(change_reason) > 0),
  CONSTRAINT project_revisions_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS project_revisions_revision_idx
  ON agent_platform.project_revisions (tenant_id, space_id, project_id, revision DESC);

CREATE TABLE IF NOT EXISTS agent_platform.field_confirmation_events (
  tenant_id       uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  project_id      uuid        NOT NULL,
  record_id       uuid        NOT NULL,
  field_id        text        NOT NULL,
  revision        bigint      NOT NULL,
  record_revision bigint      NOT NULL,
  content_digest  text        NOT NULL,
  status          text        NOT NULL,
  source_ref      jsonb       NOT NULL,
  reason          text,
  event_payload   jsonb       NOT NULL,
  idempotency_key text        NOT NULL,
  request_digest  text        NOT NULL,
  actor           text        NOT NULL,
  trace_id        text,
  recorded_at     timestamptz NOT NULL,
  CONSTRAINT field_confirmation_events_pkey PRIMARY KEY
    (tenant_id, space_id, project_id, record_id, field_id, revision),
  CONSTRAINT field_confirmation_events_idempotency_unique UNIQUE (tenant_id, space_id, idempotency_key),
  CONSTRAINT field_confirmation_events_project_fkey FOREIGN KEY (tenant_id, space_id, project_id)
    REFERENCES agent_platform.projects (tenant_id, space_id, project_id) ON DELETE CASCADE,
  CONSTRAINT field_confirmation_events_revision_positive CHECK (revision > 0),
  CONSTRAINT field_confirmation_events_record_revision_non_negative CHECK (record_revision >= 0),
  CONSTRAINT field_confirmation_events_status CHECK (status IN ('pending', 'confirmed', 'conflict')),
  CONSTRAINT field_confirmation_events_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT field_confirmation_events_request_digest_format CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT field_confirmation_events_field_nonempty CHECK (char_length(field_id) > 0),
  CONSTRAINT field_confirmation_events_source_object CHECK (jsonb_typeof(source_ref) = 'object'),
  CONSTRAINT field_confirmation_events_payload_object CHECK (jsonb_typeof(event_payload) = 'object'),
  CONSTRAINT field_confirmation_events_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 256)
);

CREATE INDEX IF NOT EXISTS field_confirmation_events_status_idx
  ON agent_platform.field_confirmation_events (tenant_id, space_id, project_id, status, record_id);

CREATE INDEX IF NOT EXISTS field_confirmation_events_record_idx
  ON agent_platform.field_confirmation_events (tenant_id, space_id, record_id, field_id, revision);

ALTER TABLE agent_platform.industry_workspaces       ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.asset_draft_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.projects                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.project_revisions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_platform.field_confirmation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.industry_workspaces;
CREATE POLICY scope_isolation ON agent_platform.industry_workspaces
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.asset_draft_versions;
CREATE POLICY scope_isolation ON agent_platform.asset_draft_versions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.projects;
CREATE POLICY scope_isolation ON agent_platform.projects
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.project_revisions;
CREATE POLICY scope_isolation ON agent_platform.project_revisions
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );

DROP POLICY IF EXISTS scope_isolation ON agent_platform.field_confirmation_events;
CREATE POLICY scope_isolation ON agent_platform.field_confirmation_events
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
