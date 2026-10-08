-- GAP-010: preserve existing consequence shapes and add exact, unitless numeric values.
-- No table/value projection is introduced. Tagged numbers are disjoint from quantities.
ALTER TABLE agent_platform.published_rule_versions
  DROP CONSTRAINT published_rule_conclusion_shape;

ALTER TABLE agent_platform.published_rule_versions
  ADD CONSTRAINT published_rule_conclusion_shape CHECK (
    conclusion IS NULL OR (
      jsonb_typeof(conclusion) = 'object'
      AND jsonb_typeof(conclusion->'predicate') = 'string'
      AND length(conclusion->>'predicate') BETWEEN 1 AND 256
      AND conclusion ? 'value'
      AND CASE WHEN conclusion->'value'->>'kind' = 'scalar_decimal' THEN (
        jsonb_typeof(conclusion->'value') = 'object'
        AND conclusion->'value' ?& ARRAY['kind', 'amount']
        AND jsonb_typeof(conclusion->'value'->'kind') = 'string'
        AND jsonb_typeof(conclusion->'value'->'amount') = 'string'
        AND length(conclusion->'value'->>'amount') BETWEEN 1 AND 64
        AND (conclusion->'value'->>'amount') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        AND ((conclusion->'value') - ARRAY['kind', 'amount']) = '{}'::jsonb
        AND (conclusion - ARRAY['predicate', 'value']) = '{}'::jsonb
      ) ELSE (
        jsonb_typeof(conclusion->'value') IN ('string', 'boolean')
        OR (
          jsonb_typeof(conclusion->'value') = 'object'
          AND conclusion->'value' ?& ARRAY['amount', 'unit']
          AND jsonb_typeof(conclusion->'value'->'amount') = 'string'
          AND jsonb_typeof(conclusion->'value'->'unit') = 'string'
        )
      ) END
    )
  );
