import type { IndustryPackPreparation, StandardProvenance } from '@ontology/contracts'

/**
 * `health-services` preparation material (FR-31, US-023; ADR-10/INV-03).
 *
 * A declaration only: it cites the standards the eventual pack will derive from and names
 * the capabilities it intends to require, but it publishes no definitions. `maturity:
 * 'preview'` reports it as `experimental`, never `validated`.
 */
export const HEALTH_SERVICES_NAMESPACE = 'health-services'

const FHIR: StandardProvenance = {
  standardRef: { id: 'hl7-fhir-r5', version: '5.0.0', digest: `sha256:${'e'.repeat(64)}` },
  provenanceKind: 'international_standard',
  clauseRef: 'HL7 FHIR R5 (resources)',
}

const ICD10: StandardProvenance = {
  standardRef: { id: 'icd-10', version: '2019', digest: `sha256:${'f'.repeat(64)}` },
  provenanceKind: 'international_standard',
  clauseRef: 'ICD-10 volume 2 (classification)',
}

export const HEALTH_SERVICES_PREPARATION: IndustryPackPreparation = {
  namespace: HEALTH_SERVICES_NAMESPACE,
  displayName: 'Health services',
  maturity: 'preview',
  standardProvenance: [FHIR, ICD10],
  intendedCapabilities: ['structured_query', 'document_search'],
  note: 'preparation only: candidate semantics are experimental and must not be treated as validated',
}
