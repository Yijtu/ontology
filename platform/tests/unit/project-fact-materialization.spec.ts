import { describe, expect, it } from 'vitest'
import { assertProjectFactInputShape, createToolContext } from '@ontology/contracts'
import type { ProjectFactInput } from '@ontology/contracts'
import { InMemoryCandidateStore, ProjectFactMaterializationService } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'
import { evaluateFilter, isDecimalQuantity, isRuleDecimalValue, isRuleScalarDecimalValue } from '@ontology/semantic-engine'

const id = '11111111-1111-4111-8111-111111111111'
const digest = `sha256:${'a'.repeat(64)}`
const version = { id: 'schema', version: '1.0.0', digest }
const pin: ProjectFactInput = { sources: [{ projectRevisionRef: { projectId: id, revision: '1', digest }, definitionRef: version, mappingRef: { ...version, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'import', sourceId: id }, objectPath: 'meter' } }, recordId: id, recordRevision: '1', contentDigest: digest, sourceDigest: digest, sourceRecordedAt: '2026-10-08T00:00:00Z', documentId: id, parseId: id, membershipRevision: '1', visibilityEpoch: '1', entityCandidateId: id }], validFrom: '2026-10-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z' }

function service() {
  return new ProjectFactMaterializationService({
    projects: { getProject: async () => undefined, getRevision: async () => undefined },
    mappings: { getMapping: async () => undefined }, records: { getRecord: async () => undefined },
    projectDocuments: { getMembership: async () => undefined, getVisibility: async () => undefined },
    ingestion: { findParseByDigest: async () => undefined }, candidates: new InMemoryCandidateStore(),
    schemaSource: { getSchema: async () => undefined }, jobs: { getJob: async () => undefined }, resolveSourceJob: async () => undefined,
  })
}

describe('mapped fact boundary', () => {
  it('validates complete immutable pins and refuses malformed/cross-shaped provenance', () => {
    expect(() => assertProjectFactInputShape(pin)).not.toThrow()
    expect(() => assertProjectFactInputShape({ ...pin, sources: [] })).toThrow('one or two')
    expect(() => assertProjectFactInputShape({ ...pin, sources: Array.from({ length: 3 }, () => pin.sources[0]) })).toThrow('one or two')
    expect(() => assertProjectFactInputShape({ ...pin, sources: [{ ...pin.sources[0], recordRevision: '-1' }] })).toThrow('malformed')
    expect(() => assertProjectFactInputShape({ ...pin, validTo: pin.validFrom })).toThrow('nonempty')
    expect(() => assertProjectFactInputShape({ ...pin, validFrom: '2026-10-01T00:00:00+08:00' })).toThrow('malformed')
  })

  it('explicitly rejects empty, duplicate and overbound selectors before accessing storage', async () => {
    const ctx = toolContext(id, id, ['platform-admin'])
    const request = { documentId: id, recordRefs: [{ recordId: id, revision: '1' }] }
    await expect(service().stageRecords(id, { ...request, recordRefs: [] }, ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service().stageRecords(id, { ...request, recordRefs: [...request.recordRefs, ...request.recordRefs] }, ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service().stageRecords(id, { ...request, recordRefs: Array.from({ length: 201 }, () => request.recordRefs[0] ?? { recordId: id, revision: '1' }) }, ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('does not let a read-only principal stage project business values', async () => {
    const base = toolContext(id, id, [])
    const ctx = createToolContext({ ...base, principal: { ...base.principal, roles: ['semantic-reviewer'] } })
    await expect(service().stageRecords(id, { documentId: id, recordRefs: [{ recordId: id, revision: '1' }] }, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('distinguishes valid exact scalar decimals from categorical strings and malformed numeric tags', () => {
    expect(isRuleScalarDecimalValue({ kind: 'scalar_decimal', amount: '9007199254740993' })).toBe(true)
    expect(isRuleScalarDecimalValue({ kind: 'scalar_decimal', amount: '1e4' })).toBe(false)
    expect(isRuleScalarDecimalValue({ kind: 'scalar_decimal', amount: '1', unit: 'kW' })).toBe(false)
    expect(isRuleScalarDecimalValue({ kind: 'scalar_decimal', amount: '1', extra: true })).toBe(false)
    expect(isRuleDecimalValue({ kind: 'wrong_tag', amount: '1', unit: 'kW' })).toBe(false)
    expect(isRuleDecimalValue({ kind: 'scalar_decimal', amount: '1', unit: 'kW' })).toBe(false)
    expect(isDecimalQuantity({ kind: 'wrong_tag', amount: '1', unit: 'kW' })).toBe(false)
    expect(isRuleDecimalValue({ amount: '1', unit: 'kW', extra: true })).toBe(false)
    expect(isRuleScalarDecimalValue({ kind: 'scalar_decimal', amount: true })).toBe(false)
    expect(evaluateFilter({ fieldRef: 'reading', op: 'gt', values: ['9007199254740992'] }, { kind: 'scalar_decimal', amount: '9007199254740993' })).toBe(true)
    expect(evaluateFilter({ fieldRef: 'label', op: 'gt', values: ['9007199254740992'] }, '9007199254740993')).toBeUndefined()
  })
})
