-- Forward-only immutable dependency pins; old applicability-only rules retain readable defaults.
ALTER TABLE agent_platform.published_rule_versions
  ADD COLUMN rule_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN dependency_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN project_id uuid,
  ADD CONSTRAINT published_rule_dependencies_shape CHECK (
    jsonb_typeof(rule_dependencies) = 'array' AND jsonb_typeof(dependency_refs) = 'array'
    AND jsonb_array_length(rule_dependencies) <= 16
    AND jsonb_array_length(rule_dependencies) = jsonb_array_length(dependency_refs)
  );

-- Rule declarations now share the existing ledger. Serialize their review writes with the
-- publication workspace lock just like definition candidates; retain all existing triggers.
CREATE OR REPLACE FUNCTION agent_platform.lock_pack_candidate_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid;
BEGIN
  IF TG_TABLE_NAME = 'semantic_candidate_reviews' THEN
    FOR target_workspace IN
      SELECT workspace_id FROM agent_platform.asset_candidate_versions
        WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND candidate_id=NEW.candidate_id
      UNION
      SELECT workspace_id FROM agent_platform.asset_rule_action_candidates
        WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND candidate_id=NEW.candidate_id
      ORDER BY workspace_id
    LOOP
      PERFORM 1 FROM agent_platform.industry_workspaces
        WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND workspace_id=target_workspace FOR UPDATE;
    END LOOP;
  ELSE
    PERFORM 1 FROM agent_platform.industry_workspaces
      WHERE tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
