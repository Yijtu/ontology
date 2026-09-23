-- Versioned home-energy plans are separate from generic run records.
CREATE TABLE IF NOT EXISTS agent_platform.energy_plan_versions (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  plan_key text NOT NULL,
  version_id uuid NOT NULL,
  plan_ref_key text NOT NULL,
  plan_ref jsonb NOT NULL,
  run_id uuid NOT NULL,
  scenario_ref jsonb NOT NULL,
  parent_plan_ref jsonb,
  state_revision bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('Selected','Superseded')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,space_id,plan_key,version_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS energy_plan_versions_one_selected
  ON agent_platform.energy_plan_versions (tenant_id,space_id,plan_key) WHERE status='Selected';
CREATE INDEX IF NOT EXISTS energy_plan_versions_parent_idx
  ON agent_platform.energy_plan_versions (tenant_id,space_id,plan_key,created_at DESC);
CREATE INDEX IF NOT EXISTS energy_plan_versions_ref_idx
  ON agent_platform.energy_plan_versions (tenant_id,space_id,plan_key,plan_ref_key,created_at DESC);
ALTER TABLE agent_platform.energy_plan_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.energy_plan_versions;
CREATE POLICY scope_isolation ON agent_platform.energy_plan_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid);
