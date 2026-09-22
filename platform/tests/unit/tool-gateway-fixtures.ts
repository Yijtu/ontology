import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { SchemaObject, ValidateFunction } from 'ajv'
import {
  BudgetLedgerError,
  createToolContext,
  type ArtifactWriteRequest,
  type BlobPutImmutableResponse,
  type EvidenceEnvelope,
  type EvidenceRecord,
  type EvidenceStorePort,
  type ImmutableArtifactWriter,
  type OperationRegistry,
  type ResolvedProfile,
  type ResourceRef,
  type ScopeRef,
  type ToolContext,
  type ToolDefinition,
} from '@ontology/contracts'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import type {
  RunToolBinding,
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolGatewayDependencies,
  ToolHandler,
  ToolSchemaValidator,
  ToolSourceObservation,
} from '@ontology/tool-services'
import { createRunToolGateway, resolveEnabledTools } from '@ontology/tool-services'
import type { BudgetLedgerPort } from '@ontology/contracts'
import { createAjv, validatorForRef } from '../contracts/helpers'
import { RecordingControlRepository } from './component-registry-fixtures'
import { sampleProfileSpec } from './profile-resolver-fixtures'

export { fixedClock, RUN_A, SCOPE_A, TENANT_A, toolContext } from './profile-resolver-fixtures'

export const GATEWAY_RUN = '77777777-7777-4777-8777-777777777777'
export const GATEWAY_LEDGER = '88888888-8888-4888-8888-888888888888'
export const SOURCE_REF = { namespace: 'ha-anker', sourceId: 'warehouse' } as const
export const DATASET_REF: ResourceRef = {
  id: '99999999-9999-4999-8999-999999999999',
  version: '1.0.0',
  digest: `sha256:${'1'.repeat(64)}`,
  kind: 'dataset',
}

const NOW = '2026-09-21T00:00:00Z'
const DEADLINE = '2026-09-21T00:10:00Z'

/** A trusted context whose allowlist is wide enough for the four tools. */
export function gatewayContext(overrides?: {
  readonly tenantId?: string
  readonly spaceId?: string
  readonly runId?: string
  readonly deadline?: string
  readonly collectionRefs?: readonly string[]
  readonly domains?: readonly string[]
  readonly resourceKinds?: ToolContext['allowedResources']['resourceKinds']
  readonly sourceRefs?: ToolContext['allowedResources']['sourceRefs']
}): ToolContext {
  const tenantId = overrides?.tenantId ?? '11111111-1111-4111-8111-111111111111'
  const spaceId = overrides?.spaceId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'user:gateway-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: overrides?.runId ?? GATEWAY_RUN,
    resolvedProfileHash: `sha256:${'2'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: overrides?.deadline ?? DEADLINE,
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId: overrides?.runId ?? GATEWAY_RUN,
      grantedAt: NOW,
      expiresAt: DEADLINE,
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: overrides?.resourceKinds ?? ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: overrides?.sourceRefs ?? [SOURCE_REF],
      collectionRefs: overrides?.collectionRefs === undefined ? ['home-energy/manuals'] : [...overrides.collectionRefs],
      domains: overrides?.domains === undefined ? ['example.com'] : [...overrides.domains],
      maxRows: 1000,
    },
    traceId: 'trace-tool-gateway',
  })
}

export const GATEWAY_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

export function resolvedProfile(overrides?: Partial<ResolvedProfile>): ResolvedProfile {
  const spec = sampleProfileSpec()
  const base: ResolvedProfile = {
    ...spec,
    resolvedVersions: [
      spec.industryRef,
      spec.runtimeRef,
      spec.policyRef,
    ],
    resolvedCapabilities: [],
    explicitDegradations: [],
    snapshotHash: `sha256:${'3'.repeat(64)}`,
    resolvedAt: NOW,
  }
  return { ...base, ...overrides }
}

/** All four tools enabled, as a full deployment would resolve them. */
export function fullProfile(): ResolvedProfile {
  return resolvedProfile({
    toolBindings: [
      { toolId: 'ontology_lookup', enabled: true },
      { toolId: 'data_query', enabled: true },
      { toolId: 'document_search', enabled: true },
      { toolId: 'web_search', enabled: true },
    ],
  })
}

export function operationRegistry(): OperationRegistry {
  const path = fileURLToPath(new URL('../contracts/fixtures/operation-registry.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as OperationRegistry
}

function toIssues(validate: ValidateFunction): { pointer: string; reason: string }[] {
  return (validate.errors ?? []).map((error) => ({
    pointer: error.instancePath,
    reason: `${error.message ?? 'invalid'}`,
  }))
}

/** The canonical JSON-Schema validator, built from the published schema bundle. */
export function canonicalToolValidator(): ToolSchemaValidator {
  const ajv: Ajv2020 = createAjv()
  return {
    validateRef: (ref, value) => {
      const validate = validatorForRef(ajv, ref)
      return validate(value) ? { valid: true, issues: [] } : { valid: false, issues: toIssues(validate) }
    },
    validateInline: (schema, value) => {
      const validate = ajv.compile(schema as SchemaObject)
      return validate(value) ? { valid: true, issues: [] } : { valid: false, issues: toIssues(validate) }
    },
  }
}

/** Controlled evidence archive with an injectable persistence failure. */
export class InMemoryEvidenceStore implements EvidenceStorePort {
  readonly records: EvidenceRecord[] = []
  failNext = false
  log: string[] = []
  #counter = 0

  async record(scopeRef: ScopeRef, envelope: EvidenceEnvelope): Promise<EvidenceRecord> {
    void scopeRef
    this.log.push('evidence')
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected evidence persistence failure')
    }
    this.#counter += 1
    const record: EvidenceRecord = {
      evidenceRef: {
        id: envelope.evidenceId,
        version: '1.0.0',
        digest: envelope.integrity.digest,
        kind: 'evidence',
      },
      envelope,
      envelopeDigest: envelope.integrity.digest,
      revision: String(this.#counter),
      recordedAt: envelope.observedAt,
    }
    this.records.push(record)
    return record
  }

  async get(scopeRef: ScopeRef, evidenceId: string): Promise<EvidenceRecord | undefined> {
    void scopeRef
    return this.records.find((record) => record.evidenceRef.id === evidenceId)
  }

  async listByRun(scopeRef: ScopeRef, runId: string): Promise<EvidenceRecord[]> {
    void scopeRef
    return this.records.filter((record) => record.envelope.producedBy.runId === runId)
  }
}

/** Controlled artifact writer with an injectable archival failure. */
export class InMemoryArtifactWriter implements ImmutableArtifactWriter {
  readonly written: Uint8Array[] = []
  failNext = false
  log: string[] = []
  #counter = 0

  async putBytes(request: ArtifactWriteRequest): Promise<BlobPutImmutableResponse> {
    this.log.push('artifact')
    if (this.failNext) {
      this.failNext = false
      throw new Error('injected artifact archival failure')
    }
    this.#counter += 1
    this.written.push(request.content)
    const digest = `sha256:${String(this.#counter).padStart(64, '0')}`
    return {
      blobRef: {
        id: randomUUID(),
        version: '1.0.0',
        digest,
        kind: 'artifact',
      },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
}

export function observation(overrides?: Partial<ToolSourceObservation>): ToolSourceObservation {
  return {
    sourceRef: SOURCE_REF,
    schemaVersion: '2026-09-01',
    consistency: 'repeatable_read',
    ...overrides,
  }
}

/** A scripted handler that records the calls it received. */
export class RecordingHandler implements ToolHandler {
  readonly calls: ToolExecutionRequest[] = []
  outcome: ToolExecutionOutcome | undefined
  error: Error | undefined

  constructor(
    readonly toolId: ToolHandler['toolId'],
    outcome: ToolExecutionOutcome,
    readonly log?: string[],
  ) {
    this.outcome = outcome
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    this.calls.push(request)
    this.log?.push('execute')
    if (this.error !== undefined) throw this.error
    if (this.outcome === undefined) throw new Error('no scripted outcome')
    return this.outcome
  }
}

export function okOutcome(payload: unknown = { items: [] }): ToolExecutionOutcome {
  return {
    payload,
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
    usage: { rows: 1 },
  }
}

export interface GatewayHarness {
  readonly gateway: ReturnType<typeof createRunToolGateway>
  readonly budget: BudgetLedgerPort
  readonly ledgerStore: InMemoryBudgetLedgerStore
  readonly evidence: InMemoryEvidenceStore
  readonly artifacts: InMemoryArtifactWriter
  readonly handlers: readonly ToolHandler[]
  readonly tools: readonly ToolDefinition[]
  readonly log: string[]
}

export function buildGateway(options: {
  readonly handlers: readonly ToolHandler[]
  readonly profile?: ResolvedProfile
  readonly ctx?: ToolContext
  readonly now?: () => string
  readonly ledgerId?: string
  readonly log?: string[]
  readonly failIntent?: boolean
}): GatewayHarness {
  const profile = options.profile ?? fullProfile()
  const log = options.log ?? []
  const ledgerStore = new InMemoryBudgetLedgerStore()
  const inner = new BudgetService({
    store: ledgerStore,
    control: new RecordingControlRepository(),
    now: options.now ?? (() => NOW),
  })
  const budget: BudgetLedgerPort = {
    openLedger: (input, ctx) => inner.openLedger(input, ctx),
    reserve: (input, ctx) => {
      log.push('reserve')
      return inner.reserve(input, ctx)
    },
    recordIntent: (input, ctx) => {
      log.push('intent')
      if (options.failIntent === true) {
        throw new BudgetLedgerError('INTENT_NOT_RECORDED', 'injected intent persistence failure')
      }
      return inner.recordIntent(input, ctx)
    },
    settle: (input, ctx) => {
      log.push(`settle:${input.status}`)
      return inner.settle(input, ctx)
    },
    remaining: (ledgerId, ctx) => inner.remaining(ledgerId, ctx),
  }
  const evidence = new InMemoryEvidenceStore()
  evidence.log = log
  const artifacts = new InMemoryArtifactWriter()
  artifacts.log = log
  const baseValidator = canonicalToolValidator()
  const validator: ToolSchemaValidator = {
    validateRef: (ref, value) => {
      log.push('validate')
      return baseValidator.validateRef(ref, value)
    },
    validateInline: (schema, value) => baseValidator.validateInline(schema, value),
  }
  const dependencies: ToolGatewayDependencies = {
    validator,
    budget,
    evidence,
    artifacts,
    handlers: options.handlers.map((handler) => ({
      toolId: handler.toolId,
      execute: (request) => {
        log.push('execute')
        return handler.execute(request)
      },
    })),
  }
  const binding: RunToolBinding = {
    runId: options.ctx?.runId ?? GATEWAY_RUN,
    ledgerId: options.ledgerId ?? GATEWAY_LEDGER,
    resolvedProfile: profile,
    operations: operationRegistry(),
  }
  return {
    gateway: createRunToolGateway(dependencies, binding),
    budget,
    ledgerStore,
    evidence,
    artifacts,
    handlers: options.handlers,
    tools: resolveEnabledTools(profile).map((entry) => entry.definition),
    log,
  }
}

/** Open the run's shared ledger, optionally with tightened limits. */
export async function openGatewayLedger(
  harness: GatewayHarness,
  ctx: ToolContext,
  overrideLimits?: { readonly maxToolCalls?: number; readonly maxRows?: number },
): Promise<void> {
  await harness.budget.openLedger(
    {
      ledgerId: GATEWAY_LEDGER,
      kind: 'run',
      runId: ctx.runId,
      ...(overrideLimits === undefined ? {} : { overrideLimits }),
    },
    ctx,
  )
}
