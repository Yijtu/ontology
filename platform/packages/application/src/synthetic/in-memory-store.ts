import {
  SyntheticValidationError,
  assertSyntheticExampleSetVersion,
  isToolContext,
} from '@ontology/contracts'
import type {
  IndustryValidationReport,
  IndustryValidationReportStore,
  ScopeRef,
  SyntheticExampleSetStore,
  SyntheticExampleSetVersion,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new SyntheticValidationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (
    ctx.allowedResources.tenantId !== tenantId ||
    scopeRef.tenantId !== tenantId ||
    scopeRef.spaceId !== spaceId
  ) {
    throw new SyntheticValidationError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function assertReportShape(value: unknown): asserts value is IndustryValidationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntheticValidationError('STORE_FAILED', 'a validation report must be an object')
  }
  const report = value as Record<string, unknown>
  if (report['dataMode'] !== 'synthetic' || report['isolationLabel'] !== 'synthetic test') {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'a validation report must stay synthetic')
  }
  if (typeof report['publishable'] !== 'boolean') {
    throw new SyntheticValidationError('STORE_FAILED', 'a validation report needs a publishable flag')
  }
}

/**
 * Reference in-memory synthetic example set store (SEE ALSO migration 065). It enforces the
 * same isolation guard and idempotency contract as the database implementation so the sandbox
 * cannot be bypassed by the in-memory path.
 */
export class InMemorySyntheticExampleSetStore implements SyntheticExampleSetStore {
  readonly #sets = new Map<string, Map<Uuid, SyntheticExampleSetVersion>>()
  readonly #idempotency = new Map<string, { readonly scope: string; readonly exampleSetId: Uuid }>()

  #store(scopeRef: ScopeRef): Map<Uuid, SyntheticExampleSetVersion> {
    const key = scopeKey(scopeRef)
    const existing = this.#sets.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, SyntheticExampleSetVersion>()
    this.#sets.set(key, created)
    return created
  }

  async insert(
    scopeRef: ScopeRef,
    set: SyntheticExampleSetVersion,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion> {
    resolveScope(scopeRef, ctx)
    assertSyntheticExampleSetVersion(set)
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${set.idempotencyKey}`
    const prior = this.#idempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#store(scopeRef).get(prior.exampleSetId)
      if (stored === undefined) {
        throw new SyntheticValidationError('STORE_FAILED', 'the idempotent example set row is missing')
      }
      if (stored.contentDigest !== set.contentDigest) {
        throw new SyntheticValidationError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different synthetic example set',
        )
      }
      return clone(stored)
    }
    const store = this.#store(scopeRef)
    if (store.has(set.exampleSetId)) {
      throw new SyntheticValidationError('STORE_FAILED', `example set ${set.exampleSetId} already exists`)
    }
    store.set(set.exampleSetId, clone(set))
    this.#idempotency.set(idempotency, { scope, exampleSetId: set.exampleSetId })
    return clone(set)
  }

  async get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    exampleSetId: Uuid,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const stored = this.#store(scopeRef).get(exampleSetId)
    return stored === undefined || stored.workspaceId !== workspaceId ? undefined : clone(stored)
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined> {
    resolveScope(scopeRef, ctx)
    const located = this.#idempotency.get(`${scopeKey(scopeRef)}\u0000${key}`)
    if (located === undefined) return undefined
    const stored = this.#store(scopeRef).get(located.exampleSetId)
    return stored === undefined ? undefined : clone(stored)
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#store(scopeRef).values()]
      .filter((set) => set.workspaceId === workspaceId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0))
      .slice(0, limit)
      .map(clone)
  }
}

/** Reference in-memory validation report store (SEE ALSO migration 065). */
export class InMemoryIndustryValidationReportStore implements IndustryValidationReportStore {
  readonly #reports = new Map<string, Map<Uuid, IndustryValidationReport>>()
  readonly #idempotency = new Map<string, { readonly scope: string; readonly validationId: Uuid }>()

  #store(scopeRef: ScopeRef): Map<Uuid, IndustryValidationReport> {
    const key = scopeKey(scopeRef)
    const existing = this.#reports.get(key)
    if (existing !== undefined) return existing
    const created = new Map<Uuid, IndustryValidationReport>()
    this.#reports.set(key, created)
    return created
  }

  async insert(
    scopeRef: ScopeRef,
    report: IndustryValidationReport,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport> {
    resolveScope(scopeRef, ctx)
    assertReportShape(report)
    const scope = scopeKey(scopeRef)
    const idempotency = `${scope}\u0000${report.idempotencyKey}`
    const prior = this.#idempotency.get(idempotency)
    if (prior !== undefined) {
      const stored = this.#store(scopeRef).get(prior.validationId)
      if (stored === undefined) {
        throw new SyntheticValidationError('STORE_FAILED', 'the idempotent validation report row is missing')
      }
      if (stored.contentDigest !== report.contentDigest) {
        throw new SyntheticValidationError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different validation report',
        )
      }
      return clone(stored)
    }
    const store = this.#store(scopeRef)
    if (store.has(report.validationId)) {
      throw new SyntheticValidationError('STORE_FAILED', `validation ${report.validationId} already exists`)
    }
    store.set(report.validationId, clone(report))
    this.#idempotency.set(idempotency, { scope, validationId: report.validationId })
    return clone(report)
  }

  async get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    validationId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined> {
    resolveScope(scopeRef, ctx)
    const stored = this.#store(scopeRef).get(validationId)
    return stored === undefined || stored.workspaceId !== workspaceId ? undefined : clone(stored)
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined> {
    resolveScope(scopeRef, ctx)
    const located = this.#idempotency.get(`${scopeKey(scopeRef)}\u0000${key}`)
    if (located === undefined) return undefined
    const stored = this.#store(scopeRef).get(located.validationId)
    return stored === undefined ? undefined : clone(stored)
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport[]> {
    resolveScope(scopeRef, ctx)
    return [...this.#store(scopeRef).values()]
      .filter((report) => report.workspaceId === workspaceId)
      .sort((left, right) => (left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0))
      .slice(0, limit)
      .map(clone)
  }
}
