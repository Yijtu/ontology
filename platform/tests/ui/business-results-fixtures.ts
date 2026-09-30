import { InMemoryTableArtifactStore, TableArtifactReadService } from '@ontology/application'
import { ProvenanceReadError } from '@ontology/provenance'
import type { EvidenceReadSurface } from '@ontology/app-api'
import {
  isTableArtifactReadError,
  sha256OfCanonical,
  tableArtifactContentDigest,
  tableManifestContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  PublishedAnswer,
  ProvenanceEvidenceView,
  ProvenanceSupportResolution,
  ResourceRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableArtifactRow,
  TableCellBinding,
  TableColumnDescriptor,
  TablePageDescriptor,
  TableVerificationReceipt,
  ToolContext,
} from '@ontology/contracts'
import { PROFILE, SCOPE, startHarness, toolContext } from './workbench-fixtures'
import type { Harness, HarnessOptions } from './workbench-fixtures'
import { createProvenanceHost } from './provenance-fixtures'

/**
 * Test-only fixture for the public typed-result workbench (V03-040 / #212). It seeds a real
 * `table-artifact-manifest@1` / `table-artifact-page@1` / `table-verification-receipt@1` set and
 * an `answer-draft@3` publication, then serves the two read endpoints the browser uses —
 * `GET /answers/{answerId}/result` and `GET /answers/{answerId}/tables/{tableId}` — through the
 * real merged `TableArtifactReadService` over an in-memory artifact store. Nothing here fakes the
 * reader: paging, cursors and the "unverified table refused" behaviour are the production reader.
 */

const ANSWER_ID = '40000000-0000-4000-8000-000000000040'

const OUTPUT_SCHEMA_REF = {
  id: 'output-schema.business-results',
  version: '1.0.0',
  digest: sha256OfCanonical({ schema: 'business-results' }),
}

const VERIFIED_TABLE_ID = 'device_capacity'
const UNVERIFIED_TABLE_ID = 'raw_compute'

const COLUMNS: readonly TableColumnDescriptor[] = [
  { columnRef: 'name', semanticPredicate: 'name', valueType: 'string', schemaPointer: '/name', displayLabel: '名称' },
  {
    columnRef: 'capacity',
    semanticPredicate: 'capacity',
    valueType: 'quantity',
    schemaPointer: '/capacity',
    displayLabel: '容量',
    requiredContextPointers: ['/capacity/unit'],
  },
]

function evidenceRef(seed: number): ResourceRef {
  return {
    id: `10000000-0000-4000-8000-${String(seed).padStart(12, '0')}`,
    version: '1.0.0',
    digest: sha256OfCanonical({ evidence: seed }),
    kind: 'evidence',
  }
}

function bindings(rowKey: string, evidence: ResourceRef, resultDigest: string): readonly TableCellBinding[] {
  return COLUMNS.map((column) => ({
    rowKey,
    columnRef: column.columnRef,
    evidenceRef: evidence,
    resultDigest,
    valuePointer: `/${column.columnRef}`,
    subjectPointer: '/subject',
    ...(column.valueType === 'quantity' ? { unitPointer: '/unit' } : {}),
  }))
}

function row(rowKey: string, subject: string, name: string, capacity: string, seed: number): TableArtifactRow {
  const evidence = evidenceRef(seed)
  const resultDigest = sha256OfCanonical({ result: seed })
  return { rowKey, subject, cells: { name, capacity }, bindings: bindings(rowKey, evidence, resultDigest) }
}

function pageBody(pageIndex: number, rows: readonly TableArtifactRow[]): TableArtifactPageBody {
  return {
    schemaVersion: 'table-artifact-page@1',
    tableId: VERIFIED_TABLE_ID,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    pageIndex,
    columnRefs: COLUMNS.map((column) => column.columnRef),
    rowKeyOrder: 'ascending',
    rows,
    coverage: { returned: rows.length, truncated: false },
  }
}

function pageRefOf(body: TableArtifactPageBody): ResourceRef {
  return {
    id: `60000000-0000-4000-8000-00000000000${body.pageIndex + 1}`,
    version: '1.0.0',
    digest: tableArtifactContentDigest(body),
    kind: 'artifact',
  }
}

function descriptorOf(body: TableArtifactPageBody, pageRef: ResourceRef): TablePageDescriptor {
  return {
    pageIndex: body.pageIndex,
    artifactRef: pageRef,
    artifactDigest: pageRef.digest,
    rowCount: body.rows.length,
    firstRowKey: body.rows[0]?.rowKey ?? 'r0',
    lastRowKey: body.rows[body.rows.length - 1]?.rowKey ?? 'r0',
    pageCoverageDigest: tablePageCoverageDigest(body),
  }
}

const PAGE_BODIES: readonly TableArtifactPageBody[] = [
  pageBody(0, [row('r1', '桥架A', '桥架A', '12.5', 1), row('r2', '桥架B', '桥架B', '3', 2)]),
  pageBody(1, [row('r3', '桥架C', '桥架C', '8.25', 3), row('r4', '桥架D', '桥架D', '7.5', 4)]),
]

const PAGE_REFS: readonly ResourceRef[] = PAGE_BODIES.map(pageRefOf)
const DESCRIPTORS: readonly TablePageDescriptor[] = PAGE_BODIES.map((body, index) =>
  descriptorOf(body, PAGE_REFS[index] as ResourceRef),
)

const MANIFEST: TableArtifactManifest = {
  schemaVersion: 'table-artifact-manifest@1',
  tableId: VERIFIED_TABLE_ID,
  outputSchemaRef: OUTPUT_SCHEMA_REF,
  columns: COLUMNS,
  totalRows: 4,
  rowKeyOrder: 'ascending',
  pages: DESCRIPTORS,
  coverage: { returned: 4, truncated: false },
  complete: true,
}

const MANIFEST_REF: ResourceRef = {
  id: '50000000-0000-4000-8000-000000000050',
  version: '1.0.0',
  digest: tableManifestContentDigest(MANIFEST),
  kind: 'artifact',
}

const RECEIPT: TableVerificationReceipt = {
  schemaVersion: 'table-verification-receipt@1',
  draftHash: sha256OfCanonical({ draft: ANSWER_ID }),
  resultManifestRef: MANIFEST_REF,
  resultManifestDigest: MANIFEST_REF.digest,
  tableId: VERIFIED_TABLE_ID,
  pageDigests: DESCRIPTORS.map((entry) => entry.artifactDigest),
  checkedRows: 4,
  expectedRows: 4,
  checkedCells: 8,
  expectedCells: 8,
  checksDigest: sha256OfCanonical({ checks: VERIFIED_TABLE_ID }),
  policyVersion: 'table-hard-verification@1',
}

const RECEIPT_REF: ResourceRef = {
  id: '70000000-0000-4000-8000-000000000070',
  version: '1.0.0',
  digest: sha256OfCanonical(RECEIPT),
  kind: 'verification',
}

const RAW_MANIFEST: TableArtifactManifest = {
  ...MANIFEST,
  tableId: UNVERIFIED_TABLE_ID,
  totalRows: 0,
  pages: [],
  complete: false,
}

async function seedArtifacts(store: InMemoryTableArtifactStore, ctx: ToolContext): Promise<void> {
  for (const [index, body] of PAGE_BODIES.entries()) {
    await store.putPage(SCOPE, PAGE_REFS[index] as ResourceRef, body, ctx)
  }
  store.indexVerifiedTable(SCOPE, ANSWER_ID, VERIFIED_TABLE_ID, {
    ref: MANIFEST_REF,
    manifest: MANIFEST,
    verificationReceiptRef: RECEIPT_REF,
  })
  store.indexVerifiedTable(SCOPE, ANSWER_ID, UNVERIFIED_TABLE_ID, {
    ref: {
      id: '50000000-0000-4000-8000-000000000051',
      version: '1.0.0',
      digest: sha256OfCanonical(RAW_MANIFEST),
      kind: 'artifact',
    },
    manifest: RAW_MANIFEST,
  })
}

function buildAnswer(runId: string): PublishedAnswer {
  const evidence = evidenceRef(1)
  const claim = {
    claimId: '30000000-0000-4000-8000-000000000030',
    kind: 'observation' as const,
    subject: '桥架A',
    predicate: 'capacity',
    value: { value: '12.5', unit: 'kWh' },
    time: { asOf: '2026-09-21T00:00:00Z' },
    references: [
      {
        evidenceRef: evidence,
        resultDigest: sha256OfCanonical({ result: 1 }),
        valuePointer: '/capacity',
        unitPointer: '/unit',
        subjectPointer: '/subject',
      },
    ],
  }
  const finalizationRef: ResourceRef = {
    id: '80000000-0000-4000-8000-000000000080',
    version: '1.0.0',
    digest: sha256OfCanonical({ finalization: ANSWER_ID }),
    kind: 'verification',
  }
  return {
    answerId: ANSWER_ID,
    runId,
    draftId: '20000000-0000-4000-8000-000000000020',
    verificationId: '30000000-0000-4000-8000-0000000000a0',
    contentHash: sha256OfCanonical({ body: ANSWER_ID }),
    evidenceManifestHash: sha256OfCanonical({ evidenceManifest: ANSWER_ID }),
    scenarioManifestHash: sha256OfCanonical({ scenarioManifest: ANSWER_ID }),
    publicationKind: 'verified',
    limitations: [],
    v3Body: {
      schemaVersion: 'answer-draft@3',
      resultManifestRef: MANIFEST_REF,
      resultManifestDigest: MANIFEST_REF.digest,
      finalizationReceiptRef: finalizationRef,
      finalizationReceiptDigest: finalizationRef.digest,
      executionBindingRef: {
        id: '90000000-0000-4000-8000-000000000090',
        version: '1.0.0',
        digest: sha256OfCanonical({ execution: ANSWER_ID }),
        kind: 'artifact',
      },
      blocks: [{ kind: 'claim', claimId: claim.claimId }],
      claims: [claim],
      assertions: [],
      limitations: [],
    },
    publishedAt: '2026-09-21T00:00:00Z',
  }
}

export interface BusinessResultsHarness {
  readonly harness: Harness
  readonly answerId: string
  readonly verifiedTableId: string
  readonly unverifiedTableId: string
  readonly runId: string
}

function mapTableErrorStatus(code: string): number {
  if (code === 'TABLE_NOT_FOUND' || code === 'PAGE_NOT_FOUND') return 404
  if (code === 'SCOPE_MISMATCH') return 403
  return 422
}

function evidenceView(seed: number, reReadability: 're_readable' | 'archived_snapshot_only' | 'unverifiable'): ProvenanceEvidenceView {
  const ref = evidenceRef(seed)
  const outcome = reReadability === 'unverifiable' ? 'unverifiable' : 'verifiable'
  const supportResolution: ProvenanceSupportResolution = { state: 'not_rule', complete: true }
  return {
    evidenceId: ref.id,
    outcome,
    kind: 'observation',
    dataMode: 'observed',
    scopeRef: { tenantId: SCOPE.tenantId, spaceId: SCOPE.spaceId },
    producedBy: { componentRef: { id: 'component.business-results', version: '1.0.0', digest: ref.digest }, runId: '00000000-0000-4000-8000-000000000000' },
    observedAt: '2026-09-21T00:00:00Z',
    recordedAt: '2026-09-21T00:00:00Z',
    revision: '1',
    resultDigest: ref.digest,
    integrityVerified: outcome === 'verifiable',
    ruleRefs: [],
    supportResolution,
    premiseGroups: [],
    sources: [
      {
        sourceRef: { namespace: 'project', sourceId: `device-row-${seed}` },
        schemaVersion: '1',
        readAt: '2026-09-21T00:00:00Z',
        ...(reReadability === 'archived_snapshot_only' ? { asOf: '2026-09-21T00:00:00Z' } : {}),
        consistency: reReadability === 'archived_snapshot_only' ? 'repeatable_read' : 'immutable',
        resultDigest: ref.digest,
        ...(reReadability === 'archived_snapshot_only' ? { archivedResultRef: ref } : {}),
        reReadability,
        ...(reReadability === 'archived_snapshot_only' ? { reason: '原始来源不可重读，仅保留已核验的归档快照' } : {}),
      },
    ],
    originalSourceReReadable: reReadability === 're_readable',
    dependencies: [],
  }
}

function createBusinessEvidenceSurface(): EvidenceReadSurface {
  const bySeed: Readonly<Record<number, 're_readable' | 'archived_snapshot_only' | 'unverifiable'>> = {
    1: 're_readable',
    2: 'archived_snapshot_only',
    3: 'unverifiable',
    4: 're_readable',
  }
  return {
    getEvidence(evidenceId: string): Promise<ProvenanceEvidenceView> {
      const seed = Number(evidenceId.slice(-1))
      const readability = bySeed[seed]
      if (readability === undefined) {
        return Promise.reject(new ProvenanceReadError('EVIDENCE_NOT_FOUND', `no authorized evidence ${evidenceId}`))
      }
      return Promise.resolve(evidenceView(seed, readability))
    },
    getDependencies(evidenceId: string): Promise<never> {
      return Promise.reject(new ProvenanceReadError('EVIDENCE_NOT_FOUND', `no dependency graph for ${evidenceId}`))
    },
    exportEvidence(): Promise<never> {
      return Promise.reject(new ProvenanceReadError('EVIDENCE_NOT_FOUND', 'export is not part of this fixture'))
    },
  }
}

export async function startBusinessResultsHarness(
  options: { readonly fixedPrincipal?: boolean; readonly streamFactory?: NonNullable<HarnessOptions['streamFactory']> } = {},
): Promise<BusinessResultsHarness> {
  const ctx = toolContext(['business-user', 'scoped-reader'], 'business-results')
  const store = new InMemoryTableArtifactStore()
  await seedArtifacts(store, ctx)
  const reader = new TableArtifactReadService({ manifests: store, pages: store, progress: store })

  let currentRunId = '00000000-0000-4000-8000-000000000000'
  const resultView = () => ({
    answerId: ANSWER_ID,
    runId: currentRunId,
    contentHash: sha256OfCanonical({ body: ANSWER_ID }),
    verificationId: '30000000-0000-4000-8000-0000000000a0',
    resultManifestRef: MANIFEST_REF,
    resultManifestDigest: MANIFEST_REF.digest,
    publicationKind: 'verified' as const,
    coverage: { returned: 4, truncated: false },
    domainStatus: 'known' as const,
    dataMode: 'observed' as const,
    tables: [
      {
        tableId: VERIFIED_TABLE_ID,
        totalRows: 4,
        columns: COLUMNS,
        complete: true,
        verificationReceiptRef: RECEIPT_REF,
      },
      { tableId: UNVERIFIED_TABLE_ID, totalRows: 0, columns: COLUMNS, complete: false },
    ],
    limitations: [],
    currentValidity: { state: 'current' as const },
  })

  const extraRoutes: NonNullable<HarnessOptions['extraRoutes']> = (app) => {
    app.get<{ Params: { answerId: string } }>('/api/v1/answers/:answerId/result', async (request, reply) => {
      if (request.params.answerId !== ANSWER_ID) {
        reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no verified result', retryable: false }, traceId: 'fixture' })
        return reply
      }
      reply.status(200).send({ data: resultView(), meta: { traceId: 'fixture' } })
      return reply
    })

    app.get<{ Params: { answerId: string; tableId: string }; Querystring: { cursor?: string } }>(
      '/api/v1/answers/:answerId/tables/:tableId',
      async (request, reply) => {
        const cursor = request.query.cursor
        try {
          const page = await reader.readPage(
            {
              answerId: request.params.answerId,
              tableId: request.params.tableId,
              ...(cursor === undefined ? {} : { cursor }),
            },
            ctx,
          )
          reply.status(200).send({ data: page, meta: { traceId: 'fixture' } })
          return reply
        } catch (error) {
          if (isTableArtifactReadError(error)) {
            const code = error.code
            reply.status(mapTableErrorStatus(code)).send({
              error: { code, message: error.message, retryable: false },
              traceId: 'fixture',
            })
            return reply
          }
          throw error
        }
      },
    )
  }

  const harness = await startHarness({
    ...(options.fixedPrincipal === true ? { fixedPrincipal: true } : {}),
    ...(options.streamFactory === undefined ? {} : { streamFactory: options.streamFactory }),
    extraRoutes,
    provenance: { evidence: createBusinessEvidenceSurface(), history: createProvenanceHost().history },
    seedAnswerForRun: (runId: string) => {
      currentRunId = runId
      return buildAnswer(runId)
    },
  })

  const created = await harness.client.createRun({
    profileRef: PROFILE,
    question: '查看设备容量',
    context: { timeZone: 'Asia/Shanghai' },
    preferences: { route: 'auto', allowWeb: false },
  })

  return {
    harness,
    answerId: ANSWER_ID,
    verifiedTableId: VERIFIED_TABLE_ID,
    unverifiedTableId: UNVERIFIED_TABLE_ID,
    runId: created.runId,
  }
}

export const BUSINESS_RESULTS_ANSWER_ID = ANSWER_ID

/** The evidence ref bound to row seed `n`; exported so a test can assert provenance directly. */
export function businessEvidenceRef(seed: number): ResourceRef {
  return evidenceRef(seed)
}
