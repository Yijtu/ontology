-- A staging head is distinct from the current visible immutable revision.
ALTER TABLE agent_platform.projects ADD COLUMN active_revision bigint;
UPDATE agent_platform.projects SET active_revision = head_revision;
ALTER TABLE agent_platform.projects ALTER COLUMN active_revision SET NOT NULL;
CREATE FUNCTION agent_platform.initialize_project_active_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.active_revision := COALESCE(NEW.active_revision, NEW.head_revision);
  RETURN NEW;
END;
$$;
CREATE TRIGGER initialize_project_active_revision BEFORE INSERT ON agent_platform.projects
FOR EACH ROW EXECUTE FUNCTION agent_platform.initialize_project_active_revision();
ALTER TABLE agent_platform.projects ADD CONSTRAINT projects_active_revision CHECK (active_revision > 0 AND active_revision <= head_revision);
ALTER TABLE agent_platform.projects ADD COLUMN staging_writable boolean NOT NULL DEFAULT true;
ALTER TABLE agent_platform.jobs DROP CONSTRAINT jobs_kind;
ALTER TABLE agent_platform.jobs ADD CONSTRAINT jobs_kind CHECK (kind IN ('ingestion','simulation','asset_publication','dataset_materialization'));

-- Rebuild coordination, never approval or semantic truth. Original source/version pins and
-- finite shared counters survive retry; the existing ledger owns every human decision.
CREATE TABLE agent_platform.project_evolutions (
  tenant_id uuid NOT NULL, space_id uuid NOT NULL, project_id uuid NOT NULL,
  evolution_id uuid NOT NULL, job_id uuid NOT NULL, plan jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, record_operations integer NOT NULL DEFAULT 0,
  batches integer NOT NULL DEFAULT 0, candidate_ids jsonb NOT NULL DEFAULT '[]', snapshots jsonb, input_snapshot_ref jsonb, error text, lease_until timestamptz,
  idempotency_key text NOT NULL, request_digest text NOT NULL,
  actor text NOT NULL, trace_id text NOT NULL, recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, space_id, project_id, evolution_id),
  UNIQUE (tenant_id, space_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, space_id, project_id) REFERENCES agent_platform.projects (tenant_id, space_id, project_id),
  FOREIGN KEY (tenant_id, space_id, job_id) REFERENCES agent_platform.jobs (tenant_id, space_id, job_id),
  CHECK (state IN ('queued','running','awaiting_review','needs_human','ready','failed','cancelled')),
  CHECK (revision > 0 AND attempts BETWEEN 0 AND 3 AND record_operations BETWEEN 0 AND 60000 AND batches BETWEEN 0 AND 330),
  CHECK (jsonb_typeof(plan) = 'object' AND jsonb_typeof(candidate_ids) = 'array'),
  CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX project_evolution_live ON agent_platform.project_evolutions (tenant_id, space_id, project_id) WHERE state IN ('queued','running','awaiting_review','needs_human','failed');
ALTER TABLE agent_platform.project_evolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON agent_platform.project_evolutions
 USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid AND space_id = nullif(current_setting('app.space_id', true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid AND space_id = nullif(current_setting('app.space_id', true),'')::uuid);
