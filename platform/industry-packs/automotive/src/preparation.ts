import type { IndustryPackPreparation, StandardProvenance } from '@ontology/contracts'

/**
 * `automotive` preparation material (FR-31, US-023; ADR-10/INV-03).
 *
 * This is a declaration only. It cites the standards the eventual pack will derive from and
 * names the capabilities it intends to require, but it publishes no definitions and carries
 * no runtime binding, credential or physical column. `maturity: 'planned'` is what stops the
 * API/UI from reporting it as usable: preparation material is `defined`, never `validated`.
 */
export const AUTOMOTIVE_NAMESPACE = 'automotive'

const ISO_15118: StandardProvenance = {
  standardRef: { id: 'iso-15118-2', version: '2014', digest: `sha256:${'c'.repeat(64)}` },
  provenanceKind: 'international_standard',
  clauseRef: 'ISO 15118-2:2014 clause 7 (communication)',
}

const OCPP: StandardProvenance = {
  standardRef: { id: 'ocpp-2.0.1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` },
  provenanceKind: 'industry_standard',
  clauseRef: 'OCPP 2.0.1 part 2 (device model)',
}

export const AUTOMOTIVE_PREPARATION: IndustryPackPreparation = {
  namespace: AUTOMOTIVE_NAMESPACE,
  displayName: 'Automotive / EV charging',
  maturity: 'planned',
  standardProvenance: [ISO_15118, OCPP],
  intendedCapabilities: ['structured_query', 'document_search'],
  note: 'preparation only: no published definitions, no customer mapping and no live device binding',
}
