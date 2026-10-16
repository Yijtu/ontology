-- 094_research_document_members.sql
--
-- The research **staging** document set (design §4/§6, node R03).
--
-- Archiving a public page (`web_search`) or pointing at an uploaded/authorized document during a
-- research run produces a *staged* member bound to `(tenant, space, workspace, run)`. A member is
-- readable through the existing parse/span-reader/index facilities and can be composed with members
-- from other origins into one evidence set (design §4), but it is explicitly NOT part of an approved
-- `GroundingDocumentSet` and never enters a project corpus.
--
-- `staged` / `in_grounding_corpus` are literal columns with CHECK constraints, so no write path can
-- silently promote research material to formal grounding. A member is unique per
-- `(tenant, space, workspace, run, kind, document_digest)`: a repeated staging of the same archived
-- page or authorized document is an idempotent no-op that returns the stored member, and two runs
-- of the same page stay separate rows.
--
-- Every key and unique constraint carries tenant_id/space_id, RLS denies rows outside the session
-- scope and the table carries a `scope_isolation` policy. Forward-only: migrations 001..093 are
-- never edited.

CREATE TABLE IF NOT EXISTS agent_platform.research_document_members (
  tenant_id           uuid        NOT NULL,
  space_id            uuid        NOT NULL,
  workspace_id        uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  member_id           uuid        NOT NULL,
  kind                text        NOT NULL,
  document_ref        jsonb       NOT NULL,
  document_digest     text        NOT NULL,
  parse_id            uuid        NOT NULL,
  parser_version      text        NOT NULL,
  parse_ref           jsonb       NOT NULL,
  normalized_ref      jsonb,
  provenance_ref      jsonb,
  content_digest      text        NOT NULL,
  fetched_at          timestamptz,
  source_url          text,
  staged              boolean     NOT NULL DEFAULT true,
  in_grounding_corpus boolean     NOT NULL DEFAULT false,
  recorded_at         timestamptz NOT NULL,
  CONSTRAINT research_document_members_pkey PRIMARY KEY (tenant_id, space_id, member_id),
  CONSTRAINT research_document_members_identity_unique
    UNIQUE (tenant_id, space_id, workspace_id, run_id, kind, document_digest),
  CONSTRAINT research_document_members_workspace_fkey FOREIGN KEY (tenant_id, space_id, workspace_id)
    REFERENCES agent_platform.industry_workspaces (tenant_id, space_id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT research_document_members_kind CHECK (kind IN ('research_archive', 'authorized_document')),
  CONSTRAINT research_document_members_staged CHECK (staged = true),
  CONSTRAINT research_document_members_not_in_corpus CHECK (in_grounding_corpus = false),
  CONSTRAINT research_document_members_document_digest_format CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_document_members_content_digest_format CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT research_document_members_parser_version_nonempty CHECK (char_length(parser_version) > 0),
  CONSTRAINT research_document_members_document_ref_object CHECK (jsonb_typeof(document_ref) = 'object'),
  CONSTRAINT research_document_members_parse_ref_object CHECK (jsonb_typeof(parse_ref) = 'object'),
  CONSTRAINT research_document_members_normalized_ref_object CHECK (normalized_ref IS NULL OR jsonb_typeof(normalized_ref) = 'object'),
  CONSTRAINT research_document_members_provenance_ref_object CHECK (provenance_ref IS NULL OR jsonb_typeof(provenance_ref) = 'object'),
  CONSTRAINT research_document_members_source_url_https CHECK (source_url IS NULL OR source_url LIKE 'https://%')
);

-- The per-run member page is the hot read: `(workspace, run)` ordered by the keyset cursor.
CREATE INDEX IF NOT EXISTS research_document_members_run_idx
  ON agent_platform.research_document_members (tenant_id, space_id, workspace_id, run_id, recorded_at, member_id);

ALTER TABLE agent_platform.research_document_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_isolation ON agent_platform.research_document_members;
CREATE POLICY scope_isolation ON agent_platform.research_document_members
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND space_id = nullif(current_setting('app.space_id', true), '')::uuid
  );
