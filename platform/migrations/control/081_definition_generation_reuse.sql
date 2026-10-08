-- A generation may reuse an immutable candidate from its original producing batch.
-- This records references only; approval remains in semantic_candidate_reviews.
ALTER TABLE agent_platform.asset_candidate_batches
  ADD COLUMN reused_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(reused_candidate_ids) = 'array'
    AND NOT jsonb_path_exists(reused_candidate_ids,
      '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))'));
