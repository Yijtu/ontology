-- A reviewed business consequence is optional. Rules without one remain applicability-only.
ALTER TABLE agent_platform.published_rule_versions
  ADD COLUMN conclusion jsonb;

ALTER TABLE agent_platform.published_rule_versions
  ADD CONSTRAINT published_rule_conclusion_shape CHECK (
    conclusion IS NULL OR (
      jsonb_typeof(conclusion) = 'object'
      AND jsonb_typeof(conclusion->'predicate') = 'string'
      AND length(conclusion->>'predicate') BETWEEN 1 AND 256
      AND conclusion ? 'value'
      AND (
        jsonb_typeof(conclusion->'value') IN ('string', 'boolean')
        OR (
          jsonb_typeof(conclusion->'value') = 'object'
          AND conclusion->'value' ?& ARRAY['amount', 'unit']
          AND jsonb_typeof(conclusion->'value'->'amount') = 'string'
          AND jsonb_typeof(conclusion->'value'->'unit') = 'string'
        )
      )
    )
  );
