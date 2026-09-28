import { describe, expect, it } from 'vitest'
import type { PublishedStatement, VersionRef } from '@ontology/contracts'
import { projectPublishedAttributeFacts, ruleFactsFromStatements } from '@ontology/semantic-engine'

const schemaRef: VersionRef = {
  id: 'schema-facility',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}

function statement(overrides: Partial<PublishedStatement> = {}): PublishedStatement {
  return {
    statementId: '00000000-0000-4000-8000-000000000001',
    propositionKey: 'facility.attributes',
    kind: 'entity',
    objectId: 'facility',
    subjectEntityId: 'entity-T-01',
    predicate: 'facility',
    value: {
      attributes: [
        { attributeId: 'rated_capacity', value: 7.125, unitCode: 'kW' },
        { attributeId: 'commissioned', value: true },
      ],
    },
    validFrom: '2026-09-20T00:00:00Z',
    validTo: '2026-10-01T00:00:00Z',
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: '00000000-0000-4000-8000-000000000002',
    sourceRefs: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        version: '1.0.0',
        digest: `sha256:${'b'.repeat(64)}`,
        kind: 'chunk',
      },
    ],
    publicationId: '00000000-0000-4000-8000-000000000004',
    version: '1',
    status: 'active',
    ...overrides,
  }
}

describe('published attribute projection', () => {
  it('projects exact attribute values with the original entity, schema, time, source and parent statement', () => {
    const source = statement()
    const projection = projectPublishedAttributeFacts([source], { schemaRef })
    const capacity = projection.facts.find((fact) => fact.attributeId === 'rated_capacity')
    const commissioned = projection.facts.find((fact) => fact.attributeId === 'commissioned')

    expect(projection.issues).toEqual([])
    expect(capacity).toMatchObject({
      assertionId: `${source.statementId}#rated_capacity@1`,
      logicalAssertionId: `${source.statementId}#rated_capacity`,
      recordedSeq: '1',
      op: 'assert',
      subject: 'entity-T-01',
      objectId: 'facility',
      predicate: 'rated_capacity',
      attributeId: 'rated_capacity',
      value: { amount: '7.125', unit: 'kW' },
      sourceStatementId: source.statementId,
      schemaRef,
      validity: { validFrom: '2026-09-20T00:00:00Z', validTo: '2026-10-01T00:00:00Z' },
      sourceRefs: source.sourceRefs,
    })
    expect(commissioned?.value).toBe(true)
    expect(capacity?.sourceRef).toEqual({ namespace: 'chunk', sourceId: source.sourceRefs[0]?.id })
  })

  it('keeps child identity stable across correction and retraction revisions', () => {
    const first = statement({ version: '1' })
    const corrected = statement({ version: '2', value: { attributes: [{ attributeId: 'rated_capacity', value: 8, unitCode: 'kW' }] } })
    const retracted = statement({ version: '3', status: 'retracted', value: corrected.value })
    const projection = projectPublishedAttributeFacts([first, corrected, retracted], { schemaRef })
    const revisions = projection.facts.filter((fact) => fact.attributeId === 'rated_capacity')

    expect(revisions.map((fact) => fact.logicalAssertionId)).toEqual([
      `${first.statementId}#rated_capacity`,
      `${first.statementId}#rated_capacity`,
      `${first.statementId}#rated_capacity`,
    ])
    expect(revisions.map((fact) => fact.assertionId)).toEqual([
      `${first.statementId}#rated_capacity@1`,
      `${first.statementId}#rated_capacity@2`,
      `${first.statementId}#rated_capacity@3`,
    ])
    expect(revisions.map((fact) => fact.op)).toEqual(['assert', 'correct', 'retract'])
    expect(revisions.every((fact) => fact.sourceStatementId === first.statementId)).toBe(true)
    expect(revisions.map((fact) => fact.value)).toEqual([
      { amount: '7.125', unit: 'kW' },
      { amount: '8', unit: 'kW' },
      { amount: '8', unit: 'kW' },
    ])
  })

  it('keeps missing and malformed values unknown and reports malformed quantities', () => {
    const source = statement({
      value: {
        attributes: [
          { attributeId: 'bad_number', value: Number.MAX_SAFE_INTEGER + 1, unitCode: 'kW' },
          { attributeId: 'bad_unit', value: 4, unitCode: 'kW;drop' },
          { attributeId: 'missing', value: null },
        ],
      },
    })
    const projection = projectPublishedAttributeFacts([source], { schemaRef })
    const byAttribute = new Map(projection.facts.map((fact) => [fact.attributeId, fact]))

    expect(byAttribute.get('bad_number')?.value).toBeUndefined()
    expect(byAttribute.get('bad_unit')?.value).toBeUndefined()
    expect(byAttribute.get('missing')?.value).toBeUndefined()
    expect(projection.issues.map((issue) => [issue.attributeId, issue.code])).toEqual([
      ['bad_number', 'INVALID_VALUE'],
      ['bad_unit', 'INVALID_VALUE'],
      ['missing', 'INVALID_VALUE'],
    ])
  })

  it('normalizes lexical decimals, expands exponents, and rejects invalid or incompatible quantities', () => {
    const projection = projectPublishedAttributeFacts(
      [
        statement({
          value: {
            attributes: [
              { attributeId: 'whitespace_decimal', value: ' 001.2500 ', unitCode: 'h' },
              { attributeId: 'exponent_decimal', value: '1.25e2', unitCode: 'min' },
              { attributeId: 'fractional_exponent', value: '2.5E-3', unitCode: 'kW' },
              { attributeId: 'invalid_lexical', value: '1.2 hours', unitCode: 'h' },
              { attributeId: 'exponent_over_limit', value: '1e1001', unitCode: 'h' },
              { attributeId: 'unit_disagreement', value: { amount: '3.5', unit: 'kW' }, unitCode: 'MW' },
            ],
          },
        }),
      ],
      { schemaRef },
    )
    const byId = new Map(projection.facts.map((fact) => [fact.attributeId, fact]))

    expect(byId.get('whitespace_decimal')?.value).toEqual({ amount: '1.25', unit: 'h' })
    expect(byId.get('exponent_decimal')?.value).toEqual({ amount: '125', unit: 'min' })
    expect(byId.get('fractional_exponent')?.value).toEqual({ amount: '0.0025', unit: 'kW' })
    expect(byId.get('invalid_lexical')?.value).toBeUndefined()
    expect(byId.get('exponent_over_limit')?.value).toBeUndefined()
    expect(byId.get('unit_disagreement')?.value).toBeUndefined()
    expect(projection.issues.map((issue) => issue.attributeId)).toEqual([
      'exponent_over_limit',
      'invalid_lexical',
      'unit_disagreement',
    ])
  })

  it('retains the legacy fact helper while projecting published attributes', () => {
    const facts = ruleFactsFromStatements([statement()])
    expect(facts.map((fact) => fact.predicate)).toEqual(['commissioned', 'rated_capacity'])
    expect(facts.every((fact) => fact.sourceStatementId === statement().statementId)).toBe(true)
  })
})
