import {
  INDEPENDENT_EXPECTATION_ORIGINS,
  SYNTHETIC_DATA_MODE,
  SYNTHETIC_ISOLATION_LABEL,
  SYNTHETIC_SOURCE_KIND,
  SyntheticValidationError,
  assertSyntheticExampleSetVersion,
  isIndependentExpectationOrigin,
} from '@ontology/contracts'
import type {
  GenerateSyntheticExampleSetInput,
  IndustryWorkspaceStore,
  ResourceRef,
  ReviseSyntheticExampleSetInput,
  ScopeRef,
  Sha256Digest,
  SyntheticCase,
  SyntheticCaseKind,
  SyntheticExampleSetStore,
  SyntheticExampleSetVersion,
  SyntheticExpectation,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../extraction/canonical'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const DEFAULT_PAGE = 100

/** A versioned example set is a synthetic sandbox asset, not a few-shot question/query set. */
export interface SyntheticExampleServiceDependencies {
  readonly workspaces: IndustryWorkspaceStore
  readonly sets: SyntheticExampleSetStore
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new SyntheticValidationError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may generate or edit synthetic example sets',
  )
}

function requireRevision(revision: string | undefined, action: string): string {
  if (revision === undefined) {
    throw new SyntheticValidationError('REVISION_REQUIRED', `an If-Match revision is required to ${action}`)
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new SyntheticValidationError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function caseRefOf(exampleSetId: Uuid, item: SyntheticCase): ResourceRef {
  const digest = sha256DigestOf(canonicalJson(item))
  return {
    id: candidateIdFor(sha256DigestOf(canonicalJson({ exampleSetId, caseId: item.caseId }))),
    version: '1.0.0',
    digest,
    kind: 'artifact',
  }
}

/**
 * Build the isolation-marked synthetic example set: it validates declared cases and their
 * independent expectations, requires every expected counterexample family to be represented,
 * and persists an immutable version. It never writes a real project fact, a publication or a
 * business approval; the only shared artefact is the store row guarded by the synthetic
 * markers.
 */
export class SyntheticExampleService {
  readonly #workspaces: IndustryWorkspaceStore
  readonly #sets: SyntheticExampleSetStore
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: SyntheticExampleServiceDependencies) {
    this.#workspaces = dependencies.workspaces
    this.#sets = dependencies.sets
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async generate(
    workspaceId: Uuid,
    input: GenerateSyntheticExampleSetInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const scopeRef = scopeOf(ctx)
    const workspace = await this.#workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new SyntheticValidationError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const expected = requireRevision(input.expectedRevision, 'generate synthetic examples')
    if (workspace.headRevision !== expected) {
      throw new SyntheticValidationError('VERSION_CONFLICT', 'the workspace head moved before this change')
    }
    this.#assertCases(input.caseKinds, input.cases, input.expectations)
    const contentDigest = this.#contentDigest({
      workspaceId,
      targetDraftRef: input.targetDraftRef,
      targetDefinitionRef: input.targetDefinitionRef,
      caseKinds: input.caseKinds,
      cases: input.cases,
      expectations: input.expectations,
    })
    const exampleSetId = this.#newId()
    const pageSize = input.pageSize ?? (input.cases.length === 0 ? 1 : input.cases.length)
    const set: SyntheticExampleSetVersion = {
      exampleSetId,
      workspaceId,
      sourceKind: SYNTHETIC_SOURCE_KIND,
      dataMode: SYNTHETIC_DATA_MODE,
      isolationLabel: SYNTHETIC_ISOLATION_LABEL,
      ...(input.targetDraftRef === undefined ? {} : { targetDraftRef: input.targetDraftRef }),
      ...(input.targetDefinitionRef === undefined ? {} : { targetDefinitionRef: input.targetDefinitionRef }),
      ...(input.generationPolicyRef === undefined ? {} : { generationPolicyRef: input.generationPolicyRef }),
      ...(input.generationCallRef === undefined ? {} : { generationCallRef: input.generationCallRef }),
      caseKinds: [...input.caseKinds],
      cases: input.cases.map((item) => ({ ...item })),
      expectations: input.expectations.map((item) => ({ ...item })),
      page: {
        pageIndex: input.pageIndex ?? 0,
        pageSize,
        caseRefs: input.cases.map((item) => caseRefOf(exampleSetId, item)),
      },
      contentDigest,
      idempotencyKey: key,
      actor,
      recordedAt: this.#now(),
    }
    assertSyntheticExampleSetVersion(set)
    return this.#sets.insert(scopeRef, set, ctx)
  }

  /** Append a NEW immutable version editing an existing set; the original is preserved. */
  async revise(
    workspaceId: Uuid,
    input: ReviseSyntheticExampleSetInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const scopeRef = scopeOf(ctx)
    const workspace = await this.#workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new SyntheticValidationError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const expected = requireRevision(input.expectedRevision, 'revise synthetic examples')
    if (workspace.headRevision !== expected) {
      throw new SyntheticValidationError('VERSION_CONFLICT', 'the workspace head moved before this change')
    }
    if (input.reason.trim().length === 0) {
      throw new SyntheticValidationError('INVALID_ARGUMENT', 'a synthetic example edit requires a reason')
    }
    const original = await this.#sets.get(scopeRef, workspaceId, input.exampleSetId, ctx)
    if (original === undefined) {
      throw new SyntheticValidationError(
        'EXAMPLE_SET_NOT_FOUND',
        `example set ${input.exampleSetId} is not visible in this workspace`,
      )
    }
    const caseKinds = [...new Set(input.cases.map((item) => item.caseKind))]
    this.#assertCases(caseKinds, input.cases, input.expectations)
    const contentDigest = this.#contentDigest({
      workspaceId,
      targetDraftRef: original.targetDraftRef,
      targetDefinitionRef: original.targetDefinitionRef,
      caseKinds,
      cases: input.cases,
      expectations: input.expectations,
    })
    const exampleSetId = this.#newId()
    const set: SyntheticExampleSetVersion = {
      exampleSetId,
      workspaceId,
      sourceKind: SYNTHETIC_SOURCE_KIND,
      dataMode: SYNTHETIC_DATA_MODE,
      isolationLabel: SYNTHETIC_ISOLATION_LABEL,
      ...(original.targetDraftRef === undefined ? {} : { targetDraftRef: original.targetDraftRef }),
      ...(original.targetDefinitionRef === undefined ? {} : { targetDefinitionRef: original.targetDefinitionRef }),
      ...(original.generationPolicyRef === undefined ? {} : { generationPolicyRef: original.generationPolicyRef }),
      ...(original.generationCallRef === undefined ? {} : { generationCallRef: original.generationCallRef }),
      caseKinds,
      cases: input.cases.map((item) => ({ ...item })),
      expectations: input.expectations.map((item) => ({ ...item })),
      page: {
        pageIndex: 0,
        pageSize: input.cases.length === 0 ? 1 : input.cases.length,
        caseRefs: input.cases.map((item) => caseRefOf(exampleSetId, item)),
      },
      replacesExampleSetId: original.exampleSetId,
      contentDigest,
      idempotencyKey: key,
      actor,
      recordedAt: this.#now(),
    }
    assertSyntheticExampleSetVersion(set)
    return this.#sets.insert(scopeRef, set, ctx)
  }

  get(workspaceId: Uuid, exampleSetId: Uuid, ctx: ToolContext): Promise<SyntheticExampleSetVersion | undefined> {
    return this.#sets.get(scopeOf(ctx), workspaceId, exampleSetId, ctx)
  }

  list(workspaceId: Uuid, limit: number | undefined, ctx: ToolContext): Promise<SyntheticExampleSetVersion[]> {
    return this.#sets.list(scopeOf(ctx), workspaceId, limit ?? DEFAULT_PAGE, ctx)
  }

  #assertCases(
    declaredKinds: readonly SyntheticCaseKind[],
    cases: readonly SyntheticCase[],
    expectations: readonly SyntheticExpectation[],
  ): void {
    if (cases.length === 0) {
      throw new SyntheticValidationError('INVALID_ARGUMENT', 'a synthetic example set needs at least one case')
    }
    const caseIds = new Set<string>()
    for (const item of cases) {
      if (caseIds.has(item.caseId)) {
        throw new SyntheticValidationError('INVALID_ARGUMENT', `duplicate synthetic case id ${item.caseId}`)
      }
      caseIds.add(item.caseId)
      if (!declaredKinds.includes(item.caseKind)) {
        throw new SyntheticValidationError(
          'INVALID_ARGUMENT',
          `case ${item.caseId} uses caseKind ${item.caseKind}, which is not declared`,
        )
      }
      if (item.fields.length === 0 && item.caseKind !== 'missing_parameter') {
        throw new SyntheticValidationError('INVALID_ARGUMENT', `case ${item.caseId} has no field`)
      }
    }
    for (const kind of declaredKinds) {
      if (!cases.some((item) => item.caseKind === kind)) {
        throw new SyntheticValidationError(
          'INVALID_ARGUMENT',
          `declared caseKind ${kind} is not represented by any case`,
        )
      }
    }
    if (expectations.length === 0) {
      throw new SyntheticValidationError(
        'INVALID_ARGUMENT',
        'a synthetic example set needs at least one independent expectation',
      )
    }
    const expectationIds = new Set<string>()
    for (const expectation of expectations) {
      if (expectationIds.has(expectation.expectationId)) {
        throw new SyntheticValidationError('INVALID_ARGUMENT', `duplicate expectation ${expectation.expectationId}`)
      }
      expectationIds.add(expectation.expectationId)
      if (!isIndependentExpectationOrigin(expectation.origin)) {
        throw new SyntheticValidationError(
          'EXPECTATION_NOT_INDEPENDENT',
          `expectation ${expectation.expectationId} must be expert-confirmed or an authored oracle, not ${expectation.origin}`,
        )
      }
      if (!caseIds.has(expectation.caseId)) {
        throw new SyntheticValidationError(
          'INVALID_ARGUMENT',
          `expectation ${expectation.expectationId} references unknown case ${expectation.caseId}`,
        )
      }
    }
  }

  #contentDigest(input: {
    readonly workspaceId: Uuid
    readonly targetDraftRef: VersionRef | undefined
    readonly targetDefinitionRef: VersionRef | undefined
    readonly caseKinds: readonly SyntheticCaseKind[]
    readonly cases: readonly SyntheticCase[]
    readonly expectations: readonly SyntheticExpectation[]
  }): Sha256Digest {
    return sha256DigestOf(
      canonicalJson({
        sourceKind: SYNTHETIC_SOURCE_KIND,
        dataMode: SYNTHETIC_DATA_MODE,
        workspaceId: input.workspaceId,
        targetDraftRef: input.targetDraftRef ?? null,
        targetDefinitionRef: input.targetDefinitionRef ?? null,
        caseKinds: input.caseKinds,
        cases: input.cases,
        expectations: input.expectations,
      }),
    )
  }
}

export const INDEPENDENT_SYNTHETIC_EXPECTATION_ORIGINS = INDEPENDENT_EXPECTATION_ORIGINS
