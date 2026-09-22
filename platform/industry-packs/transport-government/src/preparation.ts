import type { IndustryPackPreparation, StandardProvenance } from '@ontology/contracts'

/**
 * `transport-government` preparation material (FR-31, US-023; ADR-10/INV-03).
 *
 * A declaration only: it cites the standards the eventual pack will derive from and names
 * the capabilities it intends to require, but it publishes no definitions. `maturity:
 * 'planned'` reports it as `defined`, never `validated`.
 */
export const TRANSPORT_GOVERNMENT_NAMESPACE = 'transport-government'

const GTFS: StandardProvenance = {
  standardRef: { id: 'gtfs', version: '2024', digest: `sha256:${'1'.repeat(64)}` },
  provenanceKind: 'industry_standard',
  clauseRef: 'GTFS reference (schedule)',
}

const DCAT: StandardProvenance = {
  standardRef: { id: 'w3c-dcat-3', version: '3.0.0', digest: `sha256:${'2'.repeat(64)}` },
  provenanceKind: 'international_standard',
  clauseRef: 'W3C DCAT 3 (dataset catalogue)',
}

export const TRANSPORT_GOVERNMENT_PREPARATION: IndustryPackPreparation = {
  namespace: TRANSPORT_GOVERNMENT_NAMESPACE,
  displayName: 'Transport / government',
  maturity: 'planned',
  standardProvenance: [GTFS, DCAT],
  intendedCapabilities: ['structured_query', 'document_search'],
  note: 'preparation only: no published definitions, no customer mapping and no source binding',
}
