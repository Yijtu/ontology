-- Durable local home-energy simulation and Virtual SOLIX execution state.
CREATE TABLE IF NOT EXISTS agent_platform.energy_simulation_records (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  simulation_id uuid NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, simulation_id)
);

CREATE TABLE IF NOT EXISTS agent_platform.energy_execution_records (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  plan_ref jsonb NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, execution_id),
  UNIQUE (tenant_id, space_id, idempotency_key),
  UNIQUE (tenant_id, space_id, plan_ref)
);

CREATE TABLE IF NOT EXISTS agent_platform.virtual_solix_states (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  device_id text NOT NULL,
  revision bigint NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, device_id)
);

ALTER TABLE agent_platform.energy_simulation_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.energy_simulation_records;
CREATE POLICY scope_isolation ON agent_platform.energy_simulation_records
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid);

ALTER TABLE agent_platform.energy_execution_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.energy_execution_records;
CREATE POLICY scope_isolation ON agent_platform.energy_execution_records
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid);

ALTER TABLE agent_platform.virtual_solix_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scope_isolation ON agent_platform.virtual_solix_states;
CREATE POLICY scope_isolation ON agent_platform.virtual_solix_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND space_id = nullif(current_setting('app.space_id', true), '')::uuid);