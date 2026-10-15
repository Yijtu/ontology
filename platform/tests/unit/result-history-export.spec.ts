import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createToolContext,
  tableManifestContentDigest,
} from '@ontology/contracts'
import type {
  AnswerRevisionRecord,
  PublishedAnswer,
  ResourceRef,
  ResultHistoryPort,
  ScopeRef,
  TableArtifactManifest,
  TableColumnDescriptor,
  ToolContext,
  TypedResultManifest,
} from '@ontology/contracts'
import {
  ResultHistoryError,
  ResultHistoryService,
  VerifiedResultExportService,
  VerifiedResultReadService,
  canonicalJson,
  typedResultManifestContentDigest,
} from '@ontology/application'

/**
 * V03-041 (#214): the structured JSON export and the result revision history.
 *
 * The export is built from the same digest-verified read as the verified page, from the exact
 * hash-bound body, so its versions/status/tables/source index cannot drift from the page. The
 * history service labels the exact version this run published (`fixed_version`) apart from an
 * older revision read back (`history`) and refuses to invent a project lineage for a run that
 * has none.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const OUTPUT_SCHEMA_REF = { id: 'output.schema', version: '1.0.0', digest: DIGEST }

const COLUMNS: readonly TableColumnDescriptor[] = [
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/amount',
    requiredContextPointers: ['unitPointer'],
  },
]

const SCOPE: ScopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }

function ctxFor(): ToolContext {
  return createToolContext({
    principal: { tenantId: SCOPE.tenantId, subjectId: 'history-tester', roles: ['business-user'], scopes: [], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: {
      tenantId: SCOPE.tenantId,
      spaceId: SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `history:${randomUUID()}`,
  })
}

function evidenceRef(seed: number): ResourceRef {
  return {
    id: `10000000-0000-4000-8000-${String(seed).padStart(12, '0')}`,
    version: '1.0.0',
    digest: DIGEST,
    kind: 'evidence',
  }
}

const TABLE: TableArtifactManifest = {
  schemaVersion: 'table-artifact-manifest@1',
  tableId: 'device_capacity',
  outputSchemaRef: OUTPUT_SCHEMA_REF,
  columns: COLUMNS,
  totalRows: 1,
  rowKeyOrder: 'ascending',
  pages: [],
  coverage: { returned: 1, truncated: false },
  complete: true,
}

function buildManifest(): TypedResultManifest {
  return {
    schemaVersion: 'typed-result-manifest@1',
    executionBindingRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    taskBindingRef: { id: 'task.binding', version: '1.0.0', digest: DIGEST },
    resultKind: 'structured_query',
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    inputSnapshotRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    outputDigest: DIGEST,
    tables: [TABLE],
    limitations: ['仅覆盖已核验范围'],
    coverage: { returned: 1, truncated: false },
    domainStatus: 'known',
    dataMode: 'observed',
  }
}

function buildAnswer(runId: string, manifest: TypedResultManifest): PublishedAnswer {
  const manifestDigest = typedResultManifestContentDigest(manifest)
  return {
    answerId: randomUUID(),
    runId,
    draftId: randomUUID(),
    verificationId: randomUUID(),
    contentHash: DIGEST,
    evidenceManifestHash: DIGEST,
    scenarioManifestHash: DIGEST,
    publicationKind: 'verified',
    limitations: [],
    v3Body: {
      schemaVersion: 'answer-draft@3',
      resultManifestRef: { id: randomUUID(), version: '1.0.0', digest: manifestDigest, kind: 'artifact' },
      resultManifestDigest: manifestDigest,
      finalizationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'verification' },
      finalizationReceiptDigest: DIGEST_B,
      executionBindingRef: manifest.executionBindingRef,
      blocks: [],
      claims: [
        {
          claimId: randomUUID(),
          kind: 'observation',
          subject: '桥架A',
          predicate: 'capacity',
          value: { value: '12.5', unit: 'kWh' },
          time: { asOf: '2026-09-21T00:00:00Z' },
          references: [
            { evidenceRef: evidenceRef(1), resultDigest: DIGEST, valuePointer: '/capacity', unitPointer: '/unit', subjectPointer: '/subject' },
            { evidenceRef: evidenceRef(1), resultDigest: DIGEST, valuePointer: '/capacity', unitPointer: '/unit', subjectPointer: '/subject' },
          ],
        },
      ],
      assertions: [
        {
          assertionId: randomUUID(),
          kind: 'string',
          predicate: 'label',
          subject: '桥架A',
          value: '已核验',
          references: [
            { evidenceRef: evidenceRef(2), resultDigest: DIGEST_B, valuePointer: '/label', subjectPointer: '/subject' },
          ],
        },
      ],
      limitations: [],
    },
    publishedAt: '2026-09-21T00:00:00Z',
  }
}

interface Harness {
  readonly runId: string
  readonly answerId: string
  readonly exportService: VerifiedResultExportService
  readonly history: ResultHistoryService
  readonly answersByRun: Map<string, PublishedAnswer>
}

function buildHarness(): Harness {
  const manifest = buildManifest()
  const runId = randomUUID()
  const answer = buildAnswer(runId, manifest)
  const answersByRun = new Map<string, PublishedAnswer>([[runId, answer]])
  const answersById = new Map<string, PublishedAnswer>([[answer.answerId, answer]])

  const reads = new VerifiedResultReadService({
    answers: {
      findByAnswer: (answerId: string) => Promise.resolve(answersById.get(answerId)),
    },
    results: {
      getAuthorized: () => Promise.resolve({ integrityVerified: true }),
      readAuthorized: () => Promise.resolve(new TextEncoder().encode(canonicalJson(manifest))),
    },
    tables: {
      resolve: (_scopeRef: ScopeRef, answerId: string, tableId: string) =>
        Promise.resolve(
          answerId === answer.answerId && tableId === TABLE.tableId
            ? { ref: { id: randomUUID(), version: '1.0.0', digest: tableManifestContentDigest(TABLE), kind: 'artifact' }, manifest: TABLE, verificationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'verification' } }
            : undefined,
        ),
    },
  })

  const exportService = new VerifiedResultExportService({
    reads,
    answers: {
      findByAnswer: (answerId: string) => Promise.resolve(answersById.get(answerId)),
      findByRun: (id: string) => Promise.resolve(answersByRun.get(id)),
    },
    tables: {
      resolve: (_scopeRef: ScopeRef, answerId: string, tableId: string) =>
        Promise.resolve(
          answerId === answer.answerId && tableId === TABLE.tableId
            ? { ref: { id: randomUUID(), version: '1.0.0', digest: tableManifestContentDigest(TABLE), kind: 'artifact' }, manifest: TABLE, verificationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'verification' } }
            : undefined,
        ),
    },
    now: () => '2026-09-30T00:00:00Z',
  })

  const history = new ResultHistoryService({
    answers: { findByRun: (id: string) => Promise.resolve(answersByRun.get(id)) },
    bindings: {
      getBindingByRun: (_scopeRef: ScopeRef, id: string) =>
        Promise.resolve(
          id === runId
            ? { binding: { request: { projectRevisionRef: { projectId: PROJECT_ID, revision: '7' } } } }
            : undefined,
        ),
    },
    history: {
      listByProject: () => Promise.resolve([]),
    },
  })

  return { runId, answerId: answer.answerId, exportService, history, answersByRun }
}

const PROJECT_ID = '90000000-0000-4000-8000-000000000007'

describe('structured JSON export of a verified result', () => {
  it('exports the same version identity, status, tables and a de-duplicated source index', async () => {
    const harness = buildHarness()
    const exported = await harness.exportService.exportByRun(harness.runId, ctxFor())

    expect(exported.schemaVersion).toBe('verified-result-export@1')
    expect(exported.versions.answerId).toBe(harness.answerId)
    expect(exported.versions.runId).toBe(harness.runId)
    expect(exported.versions.contentHash).toBe(DIGEST)
    expect(exported.status.publicationKind).toBe('verified')
    expect(exported.status.domainStatus).toBe('known')
    expect(exported.tables.map((table) => table.tableId)).toEqual([TABLE.tableId])
    expect(exported.tables[0]?.verificationReceiptRef).toBeDefined()
    // Two body bindings to the same evidence result collapse; the assertion source is separate.
    expect(exported.sourceIndex).toHaveLength(2)
    expect(exported.sourceIndex.map((entry) => entry.boundBy.join(','))).toEqual(['claim', 'assertion'])
  })

  it('refuses to export a run with no published answer', async () => {
    const harness = buildHarness()
    await expect(harness.exportService.exportByRun(randomUUID(), ctxFor())).rejects.toMatchObject({
      code: 'ANSWER_NOT_FOUND',
    })
  })
})

describe('result revision history', () => {
  it('labels the current exact version fixed_version and older revisions history', async () => {
    const manifest = buildManifest()
    const runId = randomUUID()
    const current = buildAnswer(runId, manifest)
    const older = { ...buildAnswer(randomUUID(), manifest), publishedAt: '2026-09-20T00:00:00Z' }
    const answersByRun = new Map<string, PublishedAnswer>([
      [runId, current],
      [older.runId, older],
    ])
    const historyPort: ResultHistoryPort = {
      listByProject: () =>
        Promise.resolve<readonly AnswerRevisionRecord[]>([
          { answer: current, projectId: PROJECT_ID, projectRevision: '7' },
          { answer: older, projectId: PROJECT_ID, projectRevision: '6' },
        ]),
    }
    const service = new ResultHistoryService({
      answers: { findByRun: (id: string) => Promise.resolve(answersByRun.get(id)) },
      bindings: {
        getBindingByRun: () =>
          Promise.resolve({ binding: { request: { projectRevisionRef: { projectId: PROJECT_ID, revision: '7' } } } }),
      },
      history: historyPort,
    })

    const view = await service.getHistory(runId, ctxFor())
    expect(view.logicalKey).toBe(PROJECT_ID)
    expect(view.currentAnswerId).toBe(current.answerId)
    expect(view.entries).toHaveLength(2)
    expect(view.entries[0]).toMatchObject({ answerId: current.answerId, revisionIndex: 1, readKind: 'fixed_version' })
    expect(view.entries[1]).toMatchObject({ answerId: older.answerId, revisionIndex: 2, readKind: 'history' })
    for (const entry of view.entries) expect(entry.label.length).toBeGreaterThan(0)
  })

  it('returns the run own immutable version (labelled) when it has no project binding', async () => {
    const manifest = buildManifest()
    const runId = randomUUID()
    const answer = buildAnswer(runId, manifest)
    const service = new ResultHistoryService({
      answers: { findByRun: () => Promise.resolve(answer) },
      bindings: { getBindingByRun: () => Promise.resolve(undefined) },
      history: { listByProject: () => Promise.resolve([]) },
    })

    const view = await service.getHistory(runId, ctxFor())
    expect(view.logicalKey).toBe(runId)
    expect(view.projectId).toBeUndefined()
    expect(view.entries).toEqual([
      expect.objectContaining({ answerId: answer.answerId, revisionIndex: 1, readKind: 'fixed_version' }),
    ])
  })

  it('refuses a run with no visible answer', async () => {
    const service = new ResultHistoryService({
      answers: { findByRun: () => Promise.resolve(undefined) },
      bindings: { getBindingByRun: () => Promise.resolve(undefined) },
      history: { listByProject: () => Promise.resolve([]) },
    })
    await expect(service.getHistory(randomUUID(), ctxFor())).rejects.toBeInstanceOf(ResultHistoryError)
  })
})
