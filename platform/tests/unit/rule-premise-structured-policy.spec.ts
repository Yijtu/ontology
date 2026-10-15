import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256DigestOf, verifyRulePremiseSources } from '@ontology/semantic-engine'
import type { RulePremiseSourceDependencies } from '@ontology/semantic-engine'
import type { BlobGetAuthorizedRequest, EvidenceRecord, RuleComputationArtifact, ResourceRef, ScopeRef, StructuredRuleProvenanceSpan, ToolContext } from '@ontology/contracts'
import { createTestToolContext } from '../fixtures/documents/test-doubles'

const SCOPE: ScopeRef = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const CTX: ToolContext = createTestToolContext(SCOPE.tenantId, SCOPE.spaceId)
const DEFINITION = { id: 'transport.core', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` }
const RULE_REF = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` }
const PARSE_ID = '55555555-5555-4555-8555-555555555555'
const RECORD_ID = '77777777-7777-4777-8777-777777777777'
const SUBJECT_ID = '88888888-8888-4888-8888-888888888888'
const ROW_TEXT = JSON.stringify({ sourceRowKey: 'xlsx:Sheet1:row:2', cells: [['B', 'text'], ['0.20', 'number']] })
const ROW_DIGEST = `sha256:${createHash('sha256').update(new TextEncoder().encode(ROW_TEXT)).digest('hex')}`
const COMPONENT_REF = { id: 'test-producer', version: '1.0.0', digest: `sha256:${'f'.repeat(64)}` }
const COVERAGE = { status: 'complete' as const, completeness: 'complete' as const, totalUnits: 1, parsedUnits: 1, skippedUnits: 0, skippedReasons: [], notes: [] }
const documentRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: `sha256:${'1'.repeat(64)}`, kind: 'document' }

const span: StructuredRuleProvenanceSpan = { kind: 'structured', parseId: PARSE_ID, recordId: RECORD_ID,
  sourceRowKey: 'xlsx:Sheet1:row:2', locator: { kind: 'table_row', format: 'csv', recordIndex: 1, row: 2, columnFrom: 0, columnTo: 1, normalizationMapRef: 'none' }, rowDigest: ROW_DIGEST }

const textArtifactRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: ROW_DIGEST, kind: 'artifact' }

function envelope(): { record: EvidenceRecord; blobs: Map<string, Uint8Array> } {
  const binding = { schemaVersion: 'rule-policy-span-binding@1', span, documentRef, documentVersionRef: documentRef, parserVersion: '1.0.0', textArtifactRef, sourceCoverage: COVERAGE }
  const bindingBytes = new TextEncoder().encode(JSON.stringify(binding))
  const bindingRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: `sha256:${createHash('sha256').update(bindingBytes).digest('hex')}`, kind: 'artifact' }
  const body = { evidenceId: randomUUID(), kind: 'document_span' as const, scopeRef: SCOPE, producedBy: { componentRef: COMPONENT_REF }, observedAt: '2026-10-13T00:00:00Z',
    sourceSnapshots: [{ sourceRef: { namespace: 'structured-original', sourceId: documentRef.id }, schemaVersion: '1.0.0', readAt: '2026-10-13T00:00:00Z', consistency: 'repeatable_read' as const, resultDigest: ROW_DIGEST, archivedResultRef: textArtifactRef }],
    resultDigest: ROW_DIGEST, dependencies: [], dataMode: 'observed' as const, payloadRef: bindingRef }
  const envelopeDigest = sha256DigestOf(body)
  const evidenceRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: envelopeDigest, kind: 'evidence' }
  const record: EvidenceRecord = { evidenceRef, envelope: { ...body, integrity: { algorithm: 'sha256', digest: envelopeDigest, verifiedAt: '2026-10-13T00:00:00Z' } }, envelopeDigest, revision: '1', recordedAt: '2026-10-13T00:00:00Z' }
  return { record, blobs: new Map([[textArtifactRef.id, new TextEncoder().encode(ROW_TEXT)], [bindingRef.id, bindingBytes]]) }
}

function build(rowText: string) {
  const { record, blobs } = envelope()
  const artifact: RuleComputationArtifact = { schemaVersion: 'rule-computation-artifact@1', scopeRef: SCOPE, definitionRef: DEFINITION, ruleRef: RULE_REF,
    ruleId: 'flag', ruleVersionId: RULE_REF.id, publishedRevision: '1', instanceKey: 'k', objectId: 'transport_facility', subjectEntityId: SUBJECT_ID, predicate: 'transport_facility.flag',
    applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true },
    factRefs: [], sourceStatementIds: [], inputDigest: `sha256:${'2'.repeat(64)}`, computationDigest: `sha256:${'3'.repeat(64)}`, sourceSpans: [span], complete: true }
  const payload = { schemaVersion: 'rule-derivation-support-payload@1', premiseRefs: [record.evidenceRef], sourceEvidenceMappings: [],
    policySourceEvidenceMappings: [{ span, documentRef, documentVersionRef: documentRef, parserVersion: '1.0.0', textArtifactRef, sourceCoverage: COVERAGE, evidenceRef: record.evidenceRef }] }
  const deps: RulePremiseSourceDependencies = {
    evidence: { get: async (scope, evidenceId) => scope.tenantId === SCOPE.tenantId && scope.spaceId === SCOPE.spaceId && evidenceId === record.evidenceRef.id ? record : undefined },
    artifacts: {
      getAuthorized: async (request: BlobGetAuthorizedRequest) => { const bytes = blobs.get(request.blobRef.id); return bytes === undefined ? { integrityVerified: false, byteSize: 0 } : { integrityVerified: true, byteSize: bytes.byteLength } },
      readAuthorized: async (request: BlobGetAuthorizedRequest) => { const bytes = blobs.get(request.blobRef.id); if (bytes === undefined) throw new Error('missing blob'); return bytes },
    },
    candidates: { getCandidate: async () => undefined },
    documentParses: { getParse: async () => undefined, findParseByDigest: async () => undefined },
    documentSpans: { readSpan: async () => { throw new Error('text span reader must not be used for a structured clause') } },
    structuredClauses: { read: async (target) => target.kind === 'structured'
      ? { documentRef, documentVersionRef: documentRef, parserVersion: '1.0.0', rowText, sourceCoverage: COVERAGE }
      : undefined },
  }
  return { artifact, payload, deps }
}

describe('rule premise replay of a structured policy clause', () => {
  it('verifies a structured clause through the authored row and rejects a mismatched row', async () => {
    const good = build(ROW_TEXT)
    expect(await verifyRulePremiseSources(good.artifact, good.payload, good.deps, CTX, [])).toBe(true)
    const tampered = build(`${ROW_TEXT} tampered`)
    expect(await verifyRulePremiseSources(tampered.artifact, tampered.payload, tampered.deps, CTX, [])).toBe(false)
    const missing = build(ROW_TEXT)
    expect(await verifyRulePremiseSources(missing.artifact, missing.payload, { ...missing.deps, structuredClauses: { read: async () => undefined } }, CTX, [])).toBe(false)
  })
})
