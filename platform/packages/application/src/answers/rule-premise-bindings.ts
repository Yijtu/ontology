/** Preserve actual source precision and parse coverage independently of applicability. */
export function rulePremiseHasSourceLimitation(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const mappings = 'sourceEvidenceMappings' in payload ? payload.sourceEvidenceMappings : undefined
  const policies = 'policySourceEvidenceMappings' in payload ? payload.policySourceEvidenceMappings : undefined
  const artifact = 'artifact' in payload ? payload.artifact : payload
  if (typeof artifact === 'object' && artifact !== null && 'sourceSpans' in artifact && Array.isArray(artifact.sourceSpans) && artifact.sourceSpans.length === 0) return true
  const all = [...(Array.isArray(mappings) ? mappings : []), ...(Array.isArray(policies) ? policies : [])]
  if (all.some((mapping: unknown) => typeof mapping === 'object' && mapping !== null && 'sourceCoverage' in mapping && typeof mapping.sourceCoverage === 'object' &&
    mapping.sourceCoverage !== null && 'completeness' in mapping.sourceCoverage && mapping.sourceCoverage.completeness !== 'complete')) return true
  return [
    ...(Array.isArray(mappings) ? mappings.map((mapping: unknown) => typeof mapping === 'object' && mapping !== null && 'sourceSpan' in mapping ? mapping.sourceSpan : undefined) : []),
    ...(Array.isArray(policies) ? policies.map((mapping: unknown) => typeof mapping === 'object' && mapping !== null && 'span' in mapping ? mapping.span : undefined) : []),
  ].some((span: unknown) => typeof span === 'object' && span !== null && 'precision' in span && span.precision === 'approximate')
}
