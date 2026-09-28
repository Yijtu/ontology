-- Durable workflow manifests/state, verification records, and immutable answer bodies.
CREATE TABLE IF NOT EXISTS agent_platform.workflow_run_manifests (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  run_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, run_id),
  FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_platform.workflow_input_manifests (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  run_id uuid NOT NULL,
  manifest jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, manifest_id),
  FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_platform.workflow_run_states (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  run_id uuid NOT NULL,
  state jsonb NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, run_id),
  FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_platform.workflow_verifications (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  run_id uuid NOT NULL,
  record jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, verification_id),
  FOREIGN KEY (tenant_id, space_id, run_id)
    REFERENCES agent_platform.runs (tenant_id, space_id, run_id) ON DELETE CASCADE
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workflow_run_manifests',
    'workflow_input_manifests',
    'workflow_run_states',
    'workflow_verifications'
  ] LOOP
    EXECUTE format('ALTER TABLE agent_platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY scope_isolation ON agent_platform.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

ALTER TABLE agent_platform.answer_publications ADD COLUMN IF NOT EXISTS body jsonb;
