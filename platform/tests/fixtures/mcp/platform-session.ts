import { randomUUID } from 'node:crypto'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
} from '@ontology/adapter-control-postgres'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { createBlobArtifactWriter, createToolGatewayComposition } from '@ontology/app-api'
import { TOOL_CATALOGUE, createToolContext } from '@ontology/contracts'
import type {
  AllowedResources,
  Principal,
  ScopeRef,
  SourceRef,
  StructuredQueryPort,
  ToolContext,
  ToolDefinition,
  ToolGateway,
  Uuid,
} from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler, resolveEnabledTools } from '@ontology/tool-services'
import type { ToolExecutionOutcome, ToolExecutionRequest, ToolHandler } from '@ontology/tool-services'
import { assertMcpToolSession, mintSessionContext } from '@ontology/adapter-transport-mcp'
import type { McpLauncherIdentity, McpToolSession } from '@ontology/adapter-transport-mcp'
import { canonicalToolValidator, fullProfile, operationRegistry } from '../../unit/tool-gateway-fixtures'

export const MCP_SOURCE: SourceRef = { namespace: 'demo', sourceId: 'business-db' }

/** The same confirmed mapping the real data-postgres acceptance uses. */
export const MCP_MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: { sourceRef: MCP_SOURCE, objectPath: 'sales.orders' },
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer', type: 'string' },
      { name: 'amount', type: 'decimal' },
      { name: 'created_at', type: 'timestamp' },
    ],
  },
]

const NOW = '2026-09-21T00:00:00Z'
const DEADLINE = '2030-01-01T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`

export interface PlatformSessionConfig {
  readonly controlDatabaseUrl: string
  readonly businessDatabaseUrl: string
  readonly objectDir: string
  readonly identity: McpLauncherIdentity
  readonly ledgerId: Uuid
  readonly mappings?: readonly BusinessObjectMapping[]
  readonly sourceRef?: SourceRef
  readonly overrideLimits?: { readonly maxToolCalls?: number }
  /** Replace the default handlers, e.g. to wrap an outbound MCP client as a handler. */
  readonly handlerFactory?: (ctx: ToolContext) => readonly ToolHandler[]
}

export interface PlatformSession {
  readonly session: McpToolSession
  readonly context: ToolContext
  readonly gateway: ToolGateway
  readonly adapter: PostgresQueryAdapter
  readonly budget: BudgetService
  close(): Promise<void>
}

/**
 * A real platform composition shared by the local path (in-process) and the MCP path
 * (behind a stdio child). Both build the same gateway, handlers, adapters and budget
 * ledger, so the only variable under test is the transport.
 */
export function launcherIdentity(overrides: {
  readonly runId: Uuid
  readonly sessionId: string
  readonly tenantId: string
  readonly spaceId: string
  readonly allowedResources?: Partial<AllowedResources>
  readonly principal?: Partial<Principal>
}): McpLauncherIdentity {
  const principal: Principal = {
    tenantId: overrides.tenantId,
    subjectId: overrides.principal?.subjectId ?? 'mcp-launcher',
    roles: overrides.principal?.roles ?? ['business-user'],
    scopes: overrides.principal?.scopes ?? ['tool:invoke'],
    authEpoch: overrides.principal?.authEpoch ?? 1,
  }
  const allowedResources: AllowedResources = {
    tenantId: overrides.tenantId,
    spaceId: overrides.spaceId,
    resourceKinds: overrides.allowedResources?.resourceKinds ?? [
      'artifact',
      'dataset',
      'evidence',
      'document',
    ],
    sourceRefs: overrides.allowedResources?.sourceRefs ?? [MCP_SOURCE],
    collectionRefs: overrides.allowedResources?.collectionRefs ?? ['home-energy/manuals'],
    domains: overrides.allowedResources?.domains ?? ['example.com'],
    maxRows: overrides.allowedResources?.maxRows ?? 1000,
  }
  return {
    sessionId: overrides.sessionId,
    principal,
    allowedResources,
    runId: overrides.runId,
    budgetReservation: {
      reservationId: randomUUID(),
      runId: overrides.runId,
      grantedAt: NOW,
      expiresAt: DEADLINE,
    },
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: DEADLINE,
    traceId: `trace-${overrides.sessionId}`,
  }
}

/** Echoes the trusted context identity so a caller can prove the launcher, not the client, set it. */
class ContextEchoHandler implements ToolHandler {
  readonly toolId = 'ontology_lookup'
  readonly #ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.#ctx = ctx
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    void request
    return {
      payload: {
        items: [{ kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: DIGEST } }],
        gaps: [],
        definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST },
        autoPublished: false,
        trustedTenant: this.#ctx.principal.tenantId,
        trustedSpace: this.#ctx.allowedResources.spaceId,
      },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [{ sourceRef: MCP_SOURCE, schemaVersion: '2026-09-01', consistency: 'repeatable_read' }],
    }
  }
}

/** A controlled handler for the tools whose real backend is not part of this acceptance. */
class StaticToolHandler implements ToolHandler {
  readonly toolId: ToolDefinition['toolId']
  readonly #payload: unknown

  constructor(toolId: ToolDefinition['toolId'], payload: unknown) {
    this.toolId = toolId
    this.#payload = payload
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    void request
    return {
      payload: this.#payload,
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [{ sourceRef: MCP_SOURCE, schemaVersion: '2026-09-01', consistency: 'repeatable_read' }],
    }
  }
}

function definitionFor(toolId: ToolDefinition['toolId']): ToolDefinition {
  const definition = TOOL_CATALOGUE.find((candidate) => candidate.toolId === toolId)
  if (definition === undefined) throw new Error(`no canonical definition for ${toolId}`)
  return definition
}

export async function buildPlatformSession(config: PlatformSessionConfig): Promise<PlatformSession> {
  const context = mintSessionContext(config.identity)
  const objectStore = new FileSystemObjectStore(config.objectDir)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({
    connectionString: config.controlDatabaseUrl,
    maxPoolSize: 4,
  })
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  const controlDatabase = new ControlPostgresDatabase({
    connectionString: config.controlDatabaseUrl,
    maxPoolSize: 4,
  })
  const businessDb = new BusinessPostgresDatabase({
    connectionString: config.businessDatabaseUrl,
    maxPoolSize: 6,
  })
  const adapter = new PostgresQueryAdapter({
    database: businessDb,
    mappings: config.mappings ?? MCP_MAPPINGS,
    sourceRef: config.sourceRef ?? MCP_SOURCE,
    archiver: createBlobArtifactWriter(blobStore),
  })
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  const query: StructuredQueryPort = adapter
  const handlers: readonly ToolHandler[] =
    config.handlerFactory === undefined
      ? [
          new DataQueryHandler({ query, mappings: new InMemorySemanticMappingRegistry([]) }),
          new ContextEchoHandler(context),
          new StaticToolHandler('document_search', {
            spans: [],
            scoreKind: 'none',
            indexVersion: {
              indexRef: { id: 'bm25', version: '1.0.0', digest: DIGEST },
              generation: '1',
              builtAt: NOW,
            },
            completeness: 'complete',
          }),
          new StaticToolHandler('web_search', { pages: [] }),
        ]
      : config.handlerFactory(context)
  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers,
  })
  const gateway = composition.forRun({
    runId: config.identity.runId,
    ledgerId: config.ledgerId,
    resolvedProfile: fullProfile(),
    operations: operationRegistry(),
  })
  const tools = resolveEnabledTools(fullProfile()).map((entry) => entry.definition)
  const session: McpToolSession = {
    sessionId: config.identity.sessionId,
    runId: config.identity.runId,
    context,
    gateway,
    tools,
    maxCalls: 8,
  }
  assertMcpToolSession(session)
  await budget.openLedger(
    {
      ledgerId: config.ledgerId,
      kind: 'run',
      runId: config.identity.runId,
      ...(config.overrideLimits === undefined ? {} : { overrideLimits: config.overrideLimits }),
    },
    context,
  )
  return {
    session,
    context,
    gateway,
    adapter,
    budget,
    close: async () => {
      await businessDb.close().catch(() => undefined)
      await controlDatabase.close().catch(() => undefined)
      await registry.close().catch(() => undefined)
    },
  }
}

/** The canonical data_query definition used by the outbound whitelist. */
export function dataQueryDefinition(): ToolDefinition {
  return definitionFor('data_query')
}

/** The canonical ontology_lookup definition used by the outbound whitelist. */
export function ontologyLookupDefinition(): ToolDefinition {
  return definitionFor('ontology_lookup')
}

/** The canonical document_search definition used by the outbound whitelist. */
export function documentSearchDefinition(): ToolDefinition {
  return definitionFor('document_search')
}

/** The canonical web_search definition used by the outbound whitelist. */
export function webSearchDefinition(): ToolDefinition {
  return definitionFor('web_search')
}

export function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

export { createToolContext }
