-- Operational batches reuse the existing generation table, never the review ledger.
ALTER TABLE agent_platform.asset_candidate_batches
  ADD COLUMN generation_family text NOT NULL DEFAULT 'definition',
  ADD COLUMN rule_action_result jsonb;
ALTER TABLE agent_platform.asset_candidate_batches
  ADD CONSTRAINT asset_candidate_generation_family CHECK (generation_family IN ('definition', 'rule_action')),
  ADD CONSTRAINT asset_candidate_rule_action_result CHECK (
    (generation_family = 'definition' AND rule_action_result IS NULL) OR
    (generation_family = 'rule_action' AND jsonb_typeof(rule_action_result) = 'object'));
ALTER TABLE agent_platform.asset_rule_action_candidates ADD COLUMN generation_context jsonb;
ALTER TABLE agent_platform.asset_rule_action_candidates
  ADD CONSTRAINT asset_rule_action_generation_context CHECK (generation_context IS NULL OR jsonb_typeof(generation_context) = 'object');
