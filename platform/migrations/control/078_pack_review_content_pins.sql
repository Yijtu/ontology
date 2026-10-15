-- Pin approvals in the existing review ledger. Old reviews remain readable; no backfill
-- claims that a historical decision reviewed content it did not explicitly pin.
ALTER TABLE agent_platform.semantic_candidate_reviews
  ADD COLUMN content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^sha256:[0-9a-f]{64}$');

-- Candidate writes and ledger decisions serialize with publication on their scoped
-- workspace row. This also prevents a new replacement (a phantom) after the pack's
-- head/pin recheck. Unrelated workspaces remain independent.
CREATE FUNCTION agent_platform.lock_pack_candidate_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid;
BEGIN
  IF TG_TABLE_NAME = 'semantic_candidate_reviews' THEN
    SELECT workspace_id INTO target_workspace FROM agent_platform.asset_candidate_versions
      WHERE tenant_id = NEW.tenant_id AND space_id = NEW.space_id AND candidate_id = NEW.candidate_id;
  ELSE
    target_workspace := NEW.workspace_id;
  END IF;
  IF target_workspace IS NOT NULL THEN
    PERFORM 1 FROM agent_platform.industry_workspaces
      WHERE tenant_id = NEW.tenant_id AND space_id = NEW.space_id AND workspace_id = target_workspace
      FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_candidate_publication_guard BEFORE INSERT OR UPDATE
  ON agent_platform.asset_candidate_versions FOR EACH ROW
  EXECUTE FUNCTION agent_platform.lock_pack_candidate_workspace();
CREATE TRIGGER asset_rule_action_publication_guard BEFORE INSERT OR UPDATE
  ON agent_platform.asset_rule_action_candidates FOR EACH ROW
  EXECUTE FUNCTION agent_platform.lock_pack_candidate_workspace();
CREATE TRIGGER candidate_review_publication_guard BEFORE INSERT
  ON agent_platform.semantic_candidate_reviews FOR EACH ROW
  EXECUTE FUNCTION agent_platform.lock_pack_candidate_workspace();
