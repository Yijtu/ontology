-- Preserve the actual native source selection for reproducible index projections.
-- NULL is a legacy parse whose selection must be recovered from an authoritative
-- scoped mapping/job; it never means an inferred default selection.
ALTER TABLE agent_platform.document_structured_parses ADD COLUMN parse_options jsonb;
ALTER TABLE agent_platform.document_structured_parses ADD CONSTRAINT document_structured_parse_options
  CHECK (parse_options IS NULL OR jsonb_typeof(parse_options) = 'object');
