import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresTableArtifactStore,
  PostgresTableVerificationStore,
} from '@ontology/adapter-control-postgres'
import { TableHardVerificationService } from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import {
  createToolContext,
  sha256OfCanonical,
  tableArtifactContentDigest,
  tableManifestContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPutImmutableResponse,
  EvidenceEnvelope,
  EvidenceRecord,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableCellBinding,
  TableColumnDescriptor,
  ToolContext,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * V03-033 (#204): the batched full-table hard-verification receipt and its recovery progress
 * over real PostgreSQL. The unit suite proves the checks; this suite proves the receipt body
 * and progress survive the control store, are scope-isolated and are idempotent per ref digest.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DRAFT_HASH = `sha256:${'d'.repeat(64)}`
const NOW = '2026-09-30T00:00:00Z'
const TABLE_ID = 'table.energy'
const ROW_COUNT = 3

const columns: readonly TableColumnDescriptor[] = [
  { columnRef: 'site', semanticPredicate: 'site.id', valueType: 'entity_ref', schemaPointer: '/site' },
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/amount',
    requiredContextPointers: ['unitPointer'],
  },
]

function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

class MemoryArtifacts implements ImmutableArtifactWriter {
  readonly blobs = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest): Promise<BlobPutImmutableResponse> {
    const digest = digestOfBytes(request.content)
    this.blobs.set(digest, request.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest, verifiedAt: NOW },
    }
  }
}

class MemoryReader implements ScopedArtifactReader {
  readonly #artifacts: MemoryArtifacts

  constructor(artifacts: MemoryArtifacts) {
    this.#artifacts = artifacts
  }

  async read(request: ScopedArtifactReaderRequest): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('no input ref')
    const bytes = this.#artifacts.blobs.get(ref.digest)
    if (bytes === undefined) throw new Error(`no blob for ${ref.digest}`)
    return bytes
  }
}

class MemoryEvidence implements EvidenceStorePort {
  readonly #byDigest = new Map<string, { readonly record: EvidenceRecord; readonly bytes: Uint8Array }>()

  seed(scopeRef: { readonly tenantId: string; readonly spaceId: string }, payload: unknown): EvidenceRecord {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    const digest = digestOfBytes(bytes)
    const payloadRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' }
    this.#byDigest.set(digest, { record: this.#record(scopeRef, payloadRef, digest), bytes })
    return this.#byDigest.get(digest)?.record as EvidenceRecord
  }

  bytesFor(digest: string): Uint8Array | undefined {
    return this.#byDigest.get(digest)?.bytes
  }

  #record(
    scopeRef: { readonly tenantId: string; readonly spaceId: string },
    payloadRef: ResourceRef,
    digest: string,
  ): EvidenceRecord {
    const envelope: EvidenceEnvelope = {
      evidenceId: randomUUID(),
      kind: 'observation',
      scopeRef: { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      producedBy: { componentRef: { id: 'tool-gateway', version: '1.0.0', digest: DIGEST }, runId: randomUUID() },
      observedAt: NOW,
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'fixture', sourceId: 'table' },
          schemaVersion: '2026-09-01',
          readAt: NOW,
          consistency: 'repeatable_read',
          resultDigest: digest,
        },
      ],
      resultDigest: digest,
      dependencies: [],
      dataMode: 'synthetic',
      payloadRef,
      integrity: { algorithm: 'sha256', digest, verifiedAt: NOW },
    }
    return {
      evidenceRef: { id: envelope.evidenceId, version: '1.0.0', digest, kind: 'evidence' },
      envelope,
      envelopeDigest: digest,
      revision: '1',
      recordedAt: NOW,
    }
  }

  record(): Promise<EvidenceRecord> {
    return Promise.reject(new Error('not used'))
  }

  get(_scopeRef: unknown, evidenceId: string): Promise<EvidenceRecord | undefined> {
    for (const entry of this.#byDigest.values()) {
      if (entry.record.evidenceRef.id === evidenceId) return Promise.resolve(entry.record)
    }
    return Promise.resolve(undefined)
  }

  listByRun(): Promise<EvidenceRecord[]> {
    return Promise.resolve([])
  }
}

class MemoryVerificationArtifacts implements VerificationArtifactStore {
  readonly #evidence: MemoryEvidence

  constructor(evidence: MemoryEvidence) {
    this.#evidence = evidence
  }

  async getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    const bytes = this.#evidence.bytesFor(request.blobRef.digest)
    if (bytes === undefined) throw new Error('no bytes')
    return {
      blobRef: request.blobRef,
      contentDigest: request.blobRef.digest,
      mediaType: 'application/json',
      byteSize: bytes.byteLength,
      integrityVerified: true,
    }
  }

  async readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const bytes = this.#evidence.bytesFor(request.blobRef.digest)
    if (bytes === undefined) throw new Error('no bytes')
    return bytes
  }
}

function ctxFor(target: JobTestScope): ToolContext {
  const runId = randomUUID()
  return createToolContext({
    principal: { tenantId: target.tenantId, subjectId: 'table-verifier', roles: ['platform-admin', 'operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: NOW, expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: { tenantId: target.tenantId, spaceId: target.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 0 },
    traceId: `table-verify:${randomUUID()}`,
  })
}

interface BuiltTable {
  readonly manifest: TableArtifactManifest
  readonly manifestRef: ResourceRef
  readonly pages: readonly { readonly ref: ResourceRef; readonly body: TableArtifactPageBody }[]
}

function buildTable(scopeRef: { readonly tenantId: string; readonly spaceId: string }, evidence: MemoryEvidence): BuiltTable {
  const rows = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    site: `site-${String(index)}`,
    amount: `${String(10 + index)}.50`,
  }))
  const payload = {
    table: {
      columns: [
        { name: 'site', type: 'text', semanticFieldRef: 'site.id' },
        { name: 'amount', type: 'decimal', semanticFieldRef: 'energy.amount', unit: 'kWh' },
      ],
      rows: rows.map((row) => [row.site, row.amount]),
    },
  }
  const record = evidence.seed(scopeRef, payload)
  const evidenceRef = record.evidenceRef
  const resultDigest = record.envelope.resultDigest

  const body: TableArtifactPageBody = {
    schemaVersion: 'table-artifact-page@1',
    tableId: TABLE_ID,
    outputSchemaRef: { id: 'output.schema', version: '1.0.0', digest: DIGEST },
    pageIndex: 0,
    columnRefs: columns.map((column) => column.columnRef),
    rowKeyOrder: 'ascending',
    rows: rows.map((row, index) => {
      const bindings: TableCellBinding[] = [
        { rowKey: row.site, columnRef: 'site', evidenceRef, resultDigest, valuePointer: `/table/rows/${String(index)}/0`, subjectPointer: `/table/rows/${String(index)}/0`, fieldRefPointer: '/table/columns/0' },
        { rowKey: row.site, columnRef: 'amount', evidenceRef, resultDigest, valuePointer: `/table/rows/${String(index)}/1`, subjectPointer: `/table/rows/${String(index)}/0`, fieldRefPointer: '/table/columns/1', unitPointer: '/table/columns/1/unit' },
      ]
      return {
        rowKey: row.site,
        subject: row.site,
        cells: { site: row.site, amount: { value: row.amount, unit: 'kWh' } },
        bindings,
      }
    }),
    coverage: { returned: rows.length, truncated: false },
  }
  const contentDigest = tableArtifactContentDigest(body)
  const pageRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: contentDigest, kind: 'artifact' }
  const manifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: TABLE_ID,
    outputSchemaRef: { id: 'output.schema', version: '1.0.0', digest: DIGEST },
    columns,
    totalRows: ROW_COUNT,
    rowKeyOrder: 'ascending',
    pages: [
      {
        pageIndex: 0,
        artifactRef: pageRef,
        artifactDigest: contentDigest,
        rowCount: body.rows.length,
        firstRowKey: body.rows[0]?.rowKey ?? '',
        lastRowKey: body.rows[body.rows.length - 1]?.rowKey ?? '',
        pageCoverageDigest: tablePageCoverageDigest(body),
      },
    ],
    coverage: { returned: ROW_COUNT, truncated: false },
    complete: true,
  }
  const manifestRef: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: tableManifestContentDigest(manifest),
    kind: 'artifact',
  }
  return { manifest, manifestRef, pages: [{ ref: pageRef, body }] }
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let artifactStore: PostgresTableArtifactStore
let verificationStore: PostgresTableVerificationStore
let evidence: MemoryEvidence
let memoryArtifacts: MemoryArtifacts
let service: TableHardVerificationService

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scope = await createJobScope(harness.adminClient, 'table-verify')
  otherScope = await createJobScope(harness.adminClient, 'table-verify-other')
  memoryArtifacts = new MemoryArtifacts()
  artifactStore = new PostgresTableArtifactStore(database, { writer: memoryArtifacts, reader: new MemoryReader(memoryArtifacts) })
  verificationStore = new PostgresTableVerificationStore(database)
  evidence = new MemoryEvidence()
  service = new TableHardVerificationService({
    pages: artifactStore,
    evidence,
    artifacts: new MemoryVerificationArtifacts(evidence),
    receipts: verificationStore,
    progress: verificationStore,
    now: () => NOW,
  })
})

afterAll(async () => {
  await database?.close()
  await harness?.stop()
})

async function seed(target: JobTestScope): Promise<BuiltTable> {
  const built = buildTable(scopeRef(target), evidence)
  const ctx = ctxFor(target)
  for (const page of built.pages) await artifactStore.putPage(scopeRef(target), page.ref, page.body, ctx)
  return built
}

function scopeRef(target: JobTestScope): { readonly tenantId: string; readonly spaceId: string } {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

describe('table hard-verification receipt and progress over real PostgreSQL', () => {
  it('persists a receipt that binds every checked row and is read back unchanged', async () => {
    const built = await seed(scope)
    const ctx = ctxFor(scope)
    const outcome = await service.verifyTable(
      {
        resultManifestRef: built.manifestRef,
        resultManifestDigest: built.manifestRef.digest,
        draftHash: DRAFT_HASH,
        tableId: TABLE_ID,
        manifest: built.manifest,
      },
      ctx,
    )
    expect(outcome.status).toBe('pass')
    if (outcome.status !== 'pass') throw new Error('expected a pass')
    expect(outcome.report.checkedRows).toBe(ROW_COUNT)
    expect(outcome.report.checkedCells).toBe(ROW_COUNT * columns.length)

    const stored = await verificationStore.getReceipt(scopeRef(scope), outcome.receipt.ref, ctx)
    expect(stored?.receipt.resultManifestDigest).toBe(built.manifestRef.digest)
    expect(stored?.receipt.checkedRows).toBe(ROW_COUNT)
    expect(sha256OfCanonical(stored?.receipt)).toBe(outcome.receipt.ref.digest)
  })

  it('records manifest-bound recovery progress', async () => {
    const built = await seed(scope)
    const ctx = ctxFor(scope)
    const outcome = await service.verifyTable(
      {
        resultManifestRef: built.manifestRef,
        resultManifestDigest: built.manifestRef.digest,
        draftHash: DRAFT_HASH,
        tableId: TABLE_ID,
        manifest: built.manifest,
      },
      ctx,
    )
    expect(outcome.status).toBe('pass')
    const progress = await verificationStore.getProgress(scopeRef(scope), built.manifestRef, TABLE_ID, ctx)
    expect(progress?.checkedRows).toBe(ROW_COUNT)
    expect(progress?.nextPageIndex).toBe(1)
    expect(progress?.boundSubjects).toHaveLength(ROW_COUNT)
  })

  it('isolates the receipt and progress by tenant/space', async () => {
    const built = await seed(scope)
    const ctx = ctxFor(scope)
    const outcome = await service.verifyTable(
      {
        resultManifestRef: built.manifestRef,
        resultManifestDigest: built.manifestRef.digest,
        draftHash: DRAFT_HASH,
        tableId: TABLE_ID,
        manifest: built.manifest,
      },
      ctx,
    )
    if (outcome.status !== 'pass') throw new Error('expected a pass')
    const foreign = await verificationStore.getReceipt(scopeRef(otherScope), outcome.receipt.ref, ctxFor(otherScope))
    expect(foreign).toBeUndefined()
    const foreignProgress = await verificationStore.getProgress(scopeRef(otherScope), built.manifestRef, TABLE_ID, ctxFor(otherScope))
    expect(foreignProgress).toBeUndefined()
  })

  it('is idempotent for the same receipt ref and rejects content that does not match its digest', async () => {
    const built = await seed(scope)
    const ctx = ctxFor(scope)
    const outcome = await service.verifyTable(
      {
        resultManifestRef: built.manifestRef,
        resultManifestDigest: built.manifestRef.digest,
        draftHash: DRAFT_HASH,
        tableId: TABLE_ID,
        manifest: built.manifest,
      },
      ctx,
    )
    if (outcome.status !== 'pass') throw new Error('expected a pass')
    await expect(
      verificationStore.putReceipt(scopeRef(scope), outcome.receipt.ref, outcome.receipt.receipt, ctx),
    ).resolves.toBeUndefined()
    await expect(
      verificationStore.putReceipt(
        scopeRef(scope),
        { ...outcome.receipt.ref, digest: `sha256:${'b'.repeat(64)}` as const },
        outcome.receipt.receipt,
        ctx,
      ),
    ).rejects.toThrow(/does not match its content digest/)
  })
})
