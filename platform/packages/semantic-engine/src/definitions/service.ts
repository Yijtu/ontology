import { isToolContext } from '@ontology/contracts'
import type {
  ControlAppendEventRequest,
  ControlRepository,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { SemanticDefinitionError, SemanticDefinitionStoreError } from './errors'
import { definitionRefKey, sha256DigestOf } from './canonical'
import { definitionVersionDigest, validateDefinitionVersion } from './validate'
import type { SemanticDefinitionStore } from './store'
import type {
  BindDataInput,
  DefinitionBinding,
  ResolveDataDefinitionInput,
  ResolvedDataDefinition,
  SemanticDefinitionAudit,
  SemanticDefinitionEvent,
  SemanticDefinitionListFilter,
  SemanticDefinitionQuery,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
} from './types'

export interface SemanticDefinitionServiceDependencies {
  /** Durable, monotonic, idempotent control ledger (C1/D2). */
  readonly control: ControlRepository
  /** Immutable version projection, publication history and data bindings. */
  readonly store: SemanticDefinitionStore
  readonly now?: () => string
}

const PUBLISHER_ROLES: readonly string[] = ['platform-admin', 'semantic-publisher']
const BINDER_ROLES: readonly string[] = ['platform-admin', 'semantic-publisher', 'run-controller']

function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new SemanticDefinitionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new SemanticDefinitionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new SemanticDefinitionError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

function assertRole(ctx: ToolContext, roles: readonly string[], action: string): void {
  if (!roles.some((role) => ctx.principal.roles.includes(role))) {
    throw new SemanticDefinitionError('FORBIDDEN', `${action} requires one of the roles: ${roles.join(', ')}`)
  }
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

function streamRefFor(namespace: string, definitionId: string, version: string): string {
  return `definition:${namespace}:${definitionId}@${version}`
}

function publicationAudit(
  version: SemanticDefinitionVersion,
  actor: string,
  occurredAt: string,
): SemanticDefinitionAudit {
  const payload = JSON.stringify({
    namespace: version.namespace,
    definitionId: version.ref.id,
    version: version.ref.version,
    digest: version.ref.digest,
    layer: version.layer,
    publishedAt: occurredAt,
    actor,
  })
  return {
    digest: version.ref.digest,
    payloadDigest: sha256DigestOf(payload),
    idempotencyKey: `definition-publish:${version.namespace}:${version.ref.id}:${version.ref.version}`,
    occurredAt,
    actor,
  }
}

function assertDraftShape(draft: SemanticDefinitionVersionDraft): void {
  const fields: readonly (keyof SemanticDefinitionVersionDraft)[] = [
    'objects',
    'attributes',
    'relations',
    'identityScopes',
    'ruleConstraints',
    'standardProvenance',
  ]
  for (const field of fields) {
    if (!Array.isArray(draft[field])) {
      throw new SemanticDefinitionError('INVALID_ARGUMENT', `definition draft field "${field}" must be an array`)
    }
  }
  if (typeof draft.definitionId !== 'string' || typeof draft.version !== 'string' || typeof draft.namespace !== 'string') {
    throw new SemanticDefinitionError(
      'INVALID_ARGUMENT',
      'definition draft requires string definitionId, version and namespace',
    )
  }
}

/**
 * Publication and version binding of semantic definitions (D2–D4, C1/C3).
 *
 * A version is validated before it is stored: unit, cardinality, identity scope and
 * standard provenance are all checked, and a dangling or illegal reference fails
 * publication with a typed `INVALID_DEFINITION` carrying the exact issues. Nothing is
 * silently dropped and no default is filled in.
 *
 * Published versions are immutable and append-only. Data binds to the exact version it
 * was created under, so publishing a newer version never reinterprets older data.
 * Customer extensions are isolated from the industry core they build on.
 */
export class SemanticDefinitionService {
  readonly #control: ControlRepository
  readonly #store: SemanticDefinitionStore
  readonly #now: () => string

  constructor(dependencies: SemanticDefinitionServiceDependencies) {
    this.#control = dependencies.control
    this.#store = dependencies.store
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async publish(
    draft: SemanticDefinitionVersionDraft,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion> {
    resolveTrustedScope(draft.scopeRef, ctx)
    assertRole(ctx, PUBLISHER_ROLES, 'publishing a definition version')
    assertDraftShape(draft)

    const base =
      draft.baseRef === undefined ? undefined : await this.#resolveBase(draft, ctx)
    const issues = validateDefinitionVersion(draft, base === undefined ? undefined : { base })
    if (issues.length > 0) {
      throw new SemanticDefinitionError(
        'INVALID_DEFINITION',
        `definition ${draft.namespace}/${draft.definitionId}@${draft.version} failed validation and was not published`,
        { issues },
      )
    }

    const digest = definitionVersionDigest(draft)
    const ref: VersionRef = { id: draft.definitionId, version: draft.version, digest }
    const actor = ctx.principal.subjectId

    const existing = await this.#store.findVersion(
      draft.namespace,
      draft.definitionId,
      draft.version,
      draft.scopeRef,
      ctx,
    )
    if (existing !== undefined) {
      if (existing.ref.digest !== digest) throw versionConflict(draft, existing.ref.digest)
      await this.#appendAudit(draft.scopeRef, existing, publicationAudit(existing, actor, existing.publishedAt), ctx)
      return existing
    }

    const publishedAt = this.#now()
    const version: SemanticDefinitionVersion = { ...draft, ref, publishedAt }
    const audit = publicationAudit(version, actor, publishedAt)
    try {
      await this.#store.insertVersion(draft.scopeRef, version, audit, ctx)
    } catch (error) {
      if (error instanceof SemanticDefinitionStoreError && error.code === 'VERSION_EXISTS') {
        const raced = await this.#store.findVersion(
          draft.namespace,
          draft.definitionId,
          draft.version,
          draft.scopeRef,
          ctx,
        )
        if (raced !== undefined && raced.ref.digest === digest) {
          await this.#appendAudit(draft.scopeRef, raced, publicationAudit(raced, actor, raced.publishedAt), ctx)
          return raced
        }
        throw versionConflict(draft, raced?.ref.digest)
      }
      throw error
    }
    await this.#appendAudit(draft.scopeRef, version, audit, ctx)
    return version
  }

  async getVersion(
    query: SemanticDefinitionQuery,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion> {
    resolveTrustedScope(query.scopeRef, ctx)
    const version = await this.#store.findVersion(
      query.namespace,
      query.definitionId,
      query.version,
      query.scopeRef,
      ctx,
    )
    if (version === undefined) {
      throw new SemanticDefinitionError(
        'DEFINITION_NOT_FOUND',
        `definition ${query.namespace}/${query.definitionId}@${query.version} is not published in this scope`,
      )
    }
    return version
  }

  /** The versions visible in the trusted scope; the caller filters further if needed. */
  async listVersions(
    scopeRef: ScopeRef,
    filter: SemanticDefinitionListFilter,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion[]> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.listVersions(scopeRef, filter, ctx)
  }

  async getAuditTrail(
    scopeRef: ScopeRef,
    definitionId: string,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionEvent[]> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#store.listEvents(scopeRef, definitionId, ctx)
  }

  /**
   * Bind a data set to the exact definition version it was created under. The version
   * must already be published with the given digest. Re-binding to a different version is
   * refused, so a data set is never silently reinterpreted.
   */
  async bindData(input: BindDataInput, ctx: ToolContext): Promise<DefinitionBinding> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, BINDER_ROLES, 'binding data to a definition version')

    const version = await this.#requireVersionByRef(input.scopeRef, input.namespace, input.definitionRef, ctx)
    const binding: DefinitionBinding = {
      dataRef: input.dataRef,
      namespace: version.namespace,
      definitionRef: input.definitionRef,
      boundAt: this.#now(),
    }
    try {
      await this.#store.bindData(input.scopeRef, binding, ctx)
    } catch (error) {
      if (error instanceof SemanticDefinitionStoreError && error.code === 'BINDING_CONFLICT') {
        throw new SemanticDefinitionError(
          'BINDING_CONFLICT',
          `data ${input.dataRef.id} is already bound to another definition version`,
          { cause: error },
        )
      }
      throw error
    }
    const stored = await this.#store.findBinding(input.scopeRef, input.dataRef.id, ctx)
    return stored ?? binding
  }

  /**
   * Resolve a data set against its pinned definition version. After a newer version is
   * published, older data still resolves to the version it was created under.
   */
  async resolveDataDefinition(
    input: ResolveDataDefinitionInput,
    ctx: ToolContext,
  ): Promise<ResolvedDataDefinition> {
    resolveTrustedScope(input.scopeRef, ctx)
    const binding = await this.#store.findBinding(input.scopeRef, input.dataRefId, ctx)
    if (binding === undefined) {
      throw new SemanticDefinitionError(
        'BINDING_NOT_FOUND',
        `data ${input.dataRefId} is not bound to a definition version in this scope`,
      )
    }
    const version = await this.#requireVersionByRef(input.scopeRef, binding.namespace, binding.definitionRef, ctx)
    return { binding, version }
  }

  async #resolveBase(
    draft: SemanticDefinitionVersionDraft,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion> {
    const baseRef = draft.baseRef
    if (baseRef === undefined) {
      throw new SemanticDefinitionError('BASE_VERSION_NOT_FOUND', 'no base version was declared')
    }
    const base = await this.#store.findVersion(
      draft.namespace,
      baseRef.id,
      baseRef.version,
      draft.scopeRef,
      ctx,
    )
    if (base === undefined || base.ref.digest !== baseRef.digest) {
      throw new SemanticDefinitionError(
        'BASE_VERSION_NOT_FOUND',
        `base definition ${definitionRefKey(baseRef)} is not published with digest ${baseRef.digest}`,
      )
    }
    return base
  }

  async #requireVersionByRef(
    scopeRef: ScopeRef,
    namespace: string,
    ref: VersionRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion> {
    const version = await this.#store.findVersion(namespace, ref.id, ref.version, scopeRef, ctx)
    if (version === undefined || !sameRef(version.ref, ref)) {
      throw new SemanticDefinitionError(
        'DEFINITION_NOT_FOUND',
        `definition ${definitionRefKey(ref)} is not published with digest ${ref.digest} in this scope`,
      )
    }
    return version
  }

  async #appendAudit(
    scopeRef: ScopeRef,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    ctx: ToolContext,
  ): Promise<void> {
    const request: ControlAppendEventRequest = {
      scopeRef,
      streamRef: streamRefFor(version.namespace, version.ref.id, version.ref.version),
      payloadDigest: audit.payloadDigest,
      idempotencyKey: audit.idempotencyKey,
    }
    try {
      await this.#control.appendEvent(request, ctx)
    } catch (error) {
      throw new SemanticDefinitionError(
        'AUDIT_PERSIST_FAILED',
        'could not append the definition publication event to the control ledger',
        { cause: error },
      )
    }
  }
}

function versionConflict(
  draft: SemanticDefinitionVersionDraft,
  existingDigest: string | undefined,
): SemanticDefinitionError {
  return new SemanticDefinitionError(
    'DEFINITION_VERSION_CONFLICT',
    `definition ${draft.namespace}/${draft.definitionId}@${draft.version} is already published with digest ${existingDigest ?? 'unknown'}`,
    {
      issues: [
        {
          code: 'DUPLICATE_DEFINITION',
          pointer: '$.version',
          reason: 'a published version is immutable; publish a new version instead of changing its content',
        },
      ],
    },
  )
}
