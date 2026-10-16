import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresResearchDocumentSetStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentTargetedReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
  ResearchArchiveParser,
} from '@ontology/adapter-extraction-document'
import { HttpWebSearchProvider, WebPageSnapshotArchiver } from '@ontology/adapter-search-web'
import { DocumentTargetedReadService, ResearchDocumentSetService } from '@ontology/application'
import { createBlobArtifactWriter, createToolGatewayComposition } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type {
  ResearchAuthorizationReceipt,
  ResourceRef,
  ScopeRef,
  SourceRef,
  ToolCall,
  ToolContext,
  ToolGateway,
} from '@ontology/contracts'
import { BudgetService, canonicalJson } from '@ontology/core'
import { WebSearchHandler } from '@ontology/tool-services'
import type { RunToolBinding, ToolHandler } from '@ontology/tool-services'
import { createResearchDocumentSearchHandler, createResearchWebSearchHandler } from '../../apps/api/src/composition/core-research-tools'
import { createWorkspaceResearchContextResolver } from '../../apps/api/src/composition/core-workspace-research-context'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { SAFE_PAGE, scenarioWith } from '../fixtures/web-search/fixtures'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../unit/tool-gateway-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const LEDGER_A = '88888888-8888-4888-8888-888888888888'
const WORKSPACE_A = '99999999-9999-4999-8999-999999999999'
const RUN_D = '44444444-4444-4444-8444-444444444444'
const LEDGER_D = '77777777-7777-4777-8777-777777777777'
const SOURCE_REF: SourceRef = { namespace: 'public-web', sourceId: 'search' }
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }

const ARCHIVED_PAGE_HTML =
  '<html><body><h1>Heat pump tariff guide</h1><p>Residential standing charges apply daily in arrears.</p></body></html>'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function hostContext(runId: string): ToolContext {
  const grantedAt = new Date()
  const expiresAt = new Date(grantedAt.getTime() + 30 * 60_000).toISOString()
  return createToolContext({
    principal: {
      tenantId: TENANT_A,
      // The generic worker identity a research run must never be authorized by.
      subjectId: 'core-local-worker',
      roles: ['platform-admin', 'run-controller'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: `sha256:${'b'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: expiresAt,
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: grantedAt.toISOString(), expiresAt },
    allowedResources: {
      tenantId: TENANT_A,
      spaceId: SPACE_A,
      resourceKinds: ['artifact', 'document', 'evidence'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: `research-context:${runId}`,
  })
}

function receipt(runId: string, deadline: string): ResearchAuthorizationReceipt {
  return {
    schemaVersion: 'research-authorization-receipt@1',
    researchId: runId,
    runId,
    workspaceId: WORKSPACE_A,
    draftRevision: '1',
    operatorSubjectId: 'user:researcher',
    operatorRoles: ['researcher'],
    allowedCommands: ['submit_candidates'],
    materialScopeRefs: [],
    allowedDomains: ['example.com'],
    effectiveQuota: { sourceLimit: 10, candidateLimit: 10, deadline },
    deadline,
    profileRef: { id: `workspace-research:${WORKSPACE_A}`, version: '1.0.0' },
    configSnapshotHash: `sha256:${'d'.repeat(64)}`,
    issuedAt: new Date().toISOString(),
  }
}

let container: PostgresContainer | undefined
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let budget: BudgetService
let parseStore: PostgresDocumentParseStore
let extraction: LocalDocumentExtractionService
let researchMembers: PostgresResearchDocumentSetStore
let fixture: WebSearchFixture
let artifactWriter: ReturnType<typeof createBlobArtifactWriter>

const HOST_A = hostContext(RUN_A)
const HOST_D = hostContext(RUN_D)

interface RunHarness {
  readonly gateway: ToolGateway
  readonly host: ToolContext
  readonly runId: string
  readonly staging: ResearchDocumentSetService
}

let runA: RunHarness
let runD: RunHarness

/** An in-line `document_search` targeted-read call: the required search fields are ignored. */
function targetedCall(selections: readonly { documentRef: ResourceRef; parseId?: string }[]): ToolCall {
  return {
    callId: randomUUID(),
    toolId: 'document_search',
    arguments: {
      query: 'standing charges',
      allowedCollectionRefs: ['research-staging'],
      mode: 'keyword',
      targetedRead: { selections, maxBytes: 4096, limit: 4 },
    },
  }
}

async function openResearchGateway(input: {
  runId: string
  ledgerId: string
  host: ToolContext
  archiveFetch: typeof fetch
  receiptRef: ResourceRef
}): Promise<RunHarness> {
  const deadline = new Date(Date.now() + 20 * 60_000).toISOString()
  const staging = new ResearchDocumentSetService({
    members: researchMembers,
    parser: new ResearchArchiveParser({ parser: extraction }),
  })
  const targetedRead = new DocumentTargetedReadService({
    reader: new DocumentTargetedReader({ blobs: blobStore, store: parseStore }),
  })
  const context = createWorkspaceResearchContextResolver({
    readReceipt: async (_runId, ctx) => {
      const bytes = await blobStore.readAuthorized(
        { scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: input.receiptRef },
        ctx,
      )
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (typeof decoded !== 'object' || decoded === null) throw new Error('the persisted receipt is not an object')
      return decoded as ResearchAuthorizationReceipt
    },
    revocations: () => Promise.resolve([]),
  })
  const archiver = new WebPageSnapshotArchiver({ artifacts: artifactWriter, fetchImpl: input.archiveFetch })
  const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl, snapshotArchive: archiver })
  const innerWeb = new WebSearchHandler({ provider, allowWeb: true, resolvedProfile: fullProfile(), sourceRef: SOURCE_REF })
  const handlers: ToolHandler[] = [
    createResearchWebSearchHandler({ inner: innerWeb, runId: input.runId, workspaceId: WORKSPACE_A, context, staging }),
    createResearchDocumentSearchHandler({ runId: input.runId, workspaceId: WORKSPACE_A, context, members: staging, targetedRead }),
  ]
  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers,
  })
  await budget.openLedger({ ledgerId: input.ledgerId, kind: 'run', runId: input.runId, deadline }, input.host)
  const binding: RunToolBinding = { runId: input.runId, ledgerId: input.ledgerId, resolvedProfile: fullProfile(), operations: operationRegistry() }
  // The controller forwards the receipt-derived context to the runtime (design §4/§6, S07), so the
  // gateway envelope is checked against the *research* context — not the wide worker context.
  const researchCtx = (await context.resolve(input.runId, input.host)).ctx
  return { gateway: composition.forRun(binding), host: researchCtx, runId: input.runId, staging }
}

beforeAll(async () => {
  fixture = await startWebSearchFixture()

  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const adminUrl = provided !== undefined && provided.length > 0 ? provided : (container = await startPostgresContainer()).adminUrl
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(`INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'research-context') ON CONFLICT DO NOTHING`, [TENANT_A])
  await adminClient.query(`INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'research-context') ON CONFLICT DO NOTHING`, [TENANT_A, SPACE_A])
  await adminClient.query(
    `INSERT INTO agent_platform.industry_workspaces
       (tenant_id, space_id, workspace_id, namespace, display_name, boundary, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'research-context', '研究上下文工作区', '{}'::jsonb, $4, $5, 's07', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, WORKSPACE_A, `research-context-${randomUUID()}`, `sha256:${'e'.repeat(64)}`],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [appPassword])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'research-context-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 6 })
  budget = new BudgetService({ store: new PostgresBudgetLedgerStore(controlDatabase), control: new ControlPostgresRepository(controlDatabase) })
  parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  extraction = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore })
  researchMembers = new PostgresResearchDocumentSetStore(controlDatabase)
  artifactWriter = createBlobArtifactWriter(blobStore)

  // Persist each run's authorization receipt as an immutable artifact, read back by ref (never an
  // in-memory object), so the context is genuinely rebuilt from the durable receipt.
  const deadline = new Date(Date.now() + 20 * 60_000).toISOString()
  const writeReceipt = async (runId: string): Promise<ResourceRef> => {
    const bytes = new TextEncoder().encode(canonicalJson(receipt(runId, deadline)))
    const published = await artifactWriter.putBytes({ scopeRef: SCOPE_A, content: bytes, mediaType: 'application/json' }, HOST_A)
    return published.blobRef
  }
  const receiptA = await writeReceipt(RUN_A)
  const receiptD = await writeReceipt(RUN_D)

  runA = await openResearchGateway({
    runId: RUN_A,
    ledgerId: LEDGER_A,
    host: HOST_A,
    receiptRef: receiptA,
    archiveFetch: async () => new Response(ARCHIVED_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  })
  runD = await openResearchGateway({
    runId: RUN_D,
    ledgerId: LEDGER_D,
    host: HOST_D,
    receiptRef: receiptD,
    // A page the archiver cannot retrieve is a link-only discovery, never a staged member.
    archiveFetch: async () => new Response('nope', { status: 502, headers: { 'content-type': 'text/html' } }),
  })
}, 300_000)

afterAll(async () => {
  await parseStore?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
  await fixture?.stop()
})

interface PageView {
  readonly discovery?: string
  readonly url?: string
  readonly snapshotRef?: ResourceRef
  readonly parsedRef?: ResourceRef
}

function pagesOf(result: { inlineData?: unknown }): PageView[] {
  const inline = result.inlineData
  if (typeof inline !== 'object' || inline === null) return []
  const pages = (inline as Record<string, unknown>)['pages']
  return Array.isArray(pages) ? (pages as PageView[]) : []
}

function itemsOf(result: { inlineData?: unknown }): { indexState?: string; unavailableReason?: string; text?: string }[] {
  const inline = result.inlineData
  if (typeof inline !== 'object' || inline === null) return []
  const items = (inline as Record<string, unknown>)['items']
  return Array.isArray(items) ? (items as { indexState?: string; text?: string }[]) : []
}

describe('a research run reads its archived pages through the real gateway (S07)', () => {
  it('search archives a page, stages it, and targeted-reads the un-indexed body', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const search = await runA.gateway.invoke({ callId: randomUUID(), toolId: 'web_search', arguments: { query: 'heat pump tariff', allowedDomains: ['example.com'] } }, runA.host)
    expect(search.status, JSON.stringify(search.error)).toBe('ok')
    const page = pagesOf(search)[0]
    expect(page?.discovery).toBe('archived')
    expect(page?.parsedRef).toBeDefined()
    const parsedRef = page?.parsedRef
    if (parsedRef === undefined) throw new Error('the archived page carried no readable ref')

    // The archived page is staged as a readable member of this run's research evidence set.
    const members = await researchMembers.listMembers(SCOPE_A, { workspaceId: WORKSPACE_A, runId: RUN_A, limit: 50 }, runA.host)
    expect(members.members).toHaveLength(1)
    expect(members.members[0]?.kind).toBe('research_archive')
    expect(members.members[0]?.staged).toBe(true)
    expect(members.members[0]?.inGroundingCorpus).toBe(false)

    // The body is read directly from the archived parse even though no index exists (design §6).
    const read = await runA.gateway.invoke(targetedCall([{ documentRef: parsedRef }]), runA.host)
    expect(read.status, JSON.stringify(read.error)).toBe('ok')
    const item = itemsOf(read)[0]
    expect(item?.indexState).toBe('not_indexed_readable')
    expect(item?.text).toContain('standing charges')
  })

  it('reads an authorized uploaded document in the same run (multi-source evidence set)', async () => {
    const bytes = new TextEncoder().encode('AUTHORIZED MANUAL\nSection 4.2 The filter must be replaced every 90 days.')
    const stagedBlob = await blobStore.stage(bytes, { scopeRef: SCOPE_A }, runA.host)
    const published = await blobStore.publish({ scopeRef: SCOPE_A, contentDigest: stagedBlob.contentDigest, mediaType: 'text/plain', byteSize: stagedBlob.byteSize, purpose: 'document' }, runA.host)
    const parsed = await extraction.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, runA.host)
    await runA.staging.stageAuthorizedDocument(
      { workspaceId: WORKSPACE_A, runId: RUN_A, documentRef: parsed.originalRef, parseId: parsed.parseId, parserVersion: parsed.parserVersion, parseRef: parsed.spanMapRef, contentDigest: parsed.originalRef.digest },
      runA.host,
    )

    const members = await researchMembers.listMembers(SCOPE_A, { workspaceId: WORKSPACE_A, runId: RUN_A, limit: 50 }, runA.host)
    expect(members.members.some((member) => member.kind === 'authorized_document')).toBe(true)

    const read = await runA.gateway.invoke(targetedCall([{ documentRef: parsed.originalRef, parseId: parsed.parseId }]), runA.host)
    expect(read.status, JSON.stringify(read.error)).toBe('ok')
    expect(itemsOf(read)[0]?.text).toContain('filter must be replaced')
  })

  it('refuses a reference this run never staged (cross-run/discovery-only)', async () => {
    const foreign: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: `sha256:${'f'.repeat(64)}`, kind: 'artifact' }
    const read = await runA.gateway.invoke(targetedCall([{ documentRef: foreign }]), runA.host)
    expect(read.status).toBe('error')
    expect(read.error?.code).toBe('FORBIDDEN')
    expect(read.evidenceRefs).toEqual([])
  })
})

describe('a page the run could not archive is never read as an original', () => {
  it('keeps it discovery-only and stages no member', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const search = await runD.gateway.invoke({ callId: randomUUID(), toolId: 'web_search', arguments: { query: 'heat pump tariff', allowedDomains: ['example.com'] } }, runD.host)
    expect(search.status, JSON.stringify(search.error)).toBe('ok')
    expect(pagesOf(search)[0]?.discovery).toBe('discovery_only')

    const members = await researchMembers.listMembers(SCOPE_A, { workspaceId: WORKSPACE_A, runId: RUN_D, limit: 50 }, runD.host)
    expect(members.members).toEqual([])

    const foreign: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' }
    const read = await runD.gateway.invoke(targetedCall([{ documentRef: foreign }]), runD.host)
    expect(read.status).toBe('error')
    expect(read.error?.code).toBe('FORBIDDEN')
  })
})
