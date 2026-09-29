import { describe, expect, it } from 'vitest'
import type { AssertionEvidenceBinding, ClaimResultBinding, ResourceRef, VersionRef } from '@ontology/contracts'
import { fieldBindingMatches } from '@ontology/application'

const schemaRef: VersionRef = {
  id: 'transport-inspection.schema',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}
const evidenceRef: ResourceRef = {
  id: '11111111-1111-4111-8111-111111111111',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
  kind: 'evidence',
}

function payload(overrides: {
  readonly attributeId?: string
  readonly subjectEntityId?: string
  readonly sourceStatementId?: string | null
  readonly schemaVersion?: string
  readonly conceptId?: string
} = {}): unknown {
  const assertionId = 'statement-1#operating_hours@3'
  return {
    definitionVersion: schemaRef,
    items: [{
      kind: 'fact',
      ref: { id: assertionId, version: '3.0.0', digest: `sha256:${'c'.repeat(64)}` },
      conceptRef: {
        namespace: 'transport-inspection',
        conceptId: overrides.conceptId ?? overrides.attributeId ?? 'operating_hours',
        definitionVersion: overrides.schemaVersion ?? schemaRef.version,
      },
      payload: {
        subjectEntityId: overrides.subjectEntityId ?? 'asset-I-01',
        objectId: 'asset',
        attributeId: overrides.attributeId ?? 'operating_hours',
        predicate: overrides.attributeId ?? 'operating_hours',
        value: { amount: '120', unit: 'h' },
        unitCode: 'h',
        schemaRef: { ...schemaRef, version: overrides.schemaVersion ?? schemaRef.version },
        validity: { validFrom: '2026-01-01T00:00:00Z' },
        recordedSeq: '3',
        assertionId,
        logicalAssertionId: 'statement-1#operating_hours',
        ...(overrides.sourceStatementId === undefined
          ? { sourceStatementId: 'statement-1' }
          : overrides.sourceStatementId === null
            ? {}
            : { sourceStatementId: overrides.sourceStatementId }),
        sourceRefs: [evidenceRef],
      },
    }],
  }
}

function binding(overrides: Partial<ClaimResultBinding> = {}): ClaimResultBinding {
  return {
    evidenceRef,
    resultDigest: `sha256:${'d'.repeat(64)}`,
    valuePointer: '/items/0/payload/value/amount',
    unitPointer: '/items/0/payload/unitCode',
    subjectPointer: '/items/0/payload/subjectEntityId',
    fieldRefPointer: '/items/0/payload/attributeId',
    ...overrides,
  }
}

describe('strict published-fact evidence field binding', () => {
  it('accepts only the exact typed assertion field and retained source/schema provenance', () => {
    expect(fieldBindingMatches(payload(), binding(), 'operating_hours')).toBe(true)
  })

  it('rejects a pointer to another same-valued boolean attribute', () => {
    const valuePayload = payload({ attributeId: 'inspection_exempt', conceptId: 'inspection_exempt' })
    expect(fieldBindingMatches(valuePayload, binding(), 'inspection_due')).toBe(false)
    expect(fieldBindingMatches(payload(), binding({ fieldRefPointer: '/items/0/payload/objectId' }), 'operating_hours')).toBe(false)
  })

  it('rejects mismatched schema, missing source statement and cross-entity subject pointers', () => {
    expect(fieldBindingMatches(payload({ schemaVersion: '2.0.0' }), binding(), 'operating_hours')).toBe(false)
    expect(fieldBindingMatches(payload({ sourceStatementId: null }), binding(), 'operating_hours')).toBe(false)
    expect(fieldBindingMatches(payload({ subjectEntityId: 'asset-I-02' }), binding({ subjectPointer: '/items/0/payload/objectId' }), 'operating_hours')).toBe(false)
  })

  it('keeps assertion bindings on the same strict field pointer contract', () => {
    const assertionBinding: AssertionEvidenceBinding = {
      evidenceRef,
      resultDigest: `sha256:${'d'.repeat(64)}`,
      valuePointer: '/items/0/payload/value',
      subjectPointer: '/items/0/payload/subjectEntityId',
      fieldRefPointer: '/items/0/payload/attributeId',
    }
    expect(fieldBindingMatches(payload(), assertionBinding, 'operating_hours')).toBe(true)
    expect(fieldBindingMatches(payload(), {
      ...assertionBinding,
      timePointer: '/items/0/payload/validity/validFrom',
    }, 'operating_hours')).toBe(false)
  })
})
