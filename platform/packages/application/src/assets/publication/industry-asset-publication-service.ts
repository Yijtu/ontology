import {
  IndustryAssetPublicationError,
  PublishedPackAssetStoreError,
  definitionRecordOf,
  findIndustryPackViolations,
} from '@ontology/contracts'
import type {
  AssetCandidateStore,
  IndustryValidationReport,
  IndustryValidationReportStore,
  IndustryWorkspaceStore,
  NewOutboxMessage,
  PublishedPackAsset,
  PublishedPackAssetStore,
  PublishIndustryPackInput,
  ResourceRef,
  RuleActionCandidateStore,
  RuleActionCandidateVersion,
  ScopeRef,
  SemanticDefinitionAudit,
  SemanticDefinitionRecord,
  SemanticDefinitionStore,
  SyntheticExampleSetStore,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { currentDefinitionProjection } from '../definition-candidates/validation'
import { assemblePack } from './pack-assembly'

/**
 * Industry asset publication (SPEC v0.3a §3.1/§4.2/§6.1, V03-015 / #187; A.US-005,
 * P.US-005/006/011, P.FR-14/15/17).
 *
 * The service turns a human-reviewed draft plus its industry validation report into an immutable,
 * versioned pack and commits it atomically through `PublishedPackAssetStore`. Publication is
 * gated on validation:
 *
 *  - the definition/rule/action semantics must pass the semantic surface; a pack that fails it is
 *    refused with `VALIDATION_BLOCKED` and the exact blockers;
 *  - the deployment surface is reported separately; unbound actions are published as declarations
 *    with `not_executable` pins, and only a caller that demands full executability is blocked;
 *  - a stale validation (its revision no longer matches the workspace head) is refused instead of
 *    publishing an unconfirmed draft.
 *
 * The committed asset contains declarations, an authorized/redacted source index, the capability
 * state and the diff against the previous published version; it never contains a customer
 * instance, a real price table, an identity decision or a credential (INV-03/ADR-03).
 */

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const DEFAULT_PAGE = 100
const CANDIDATE_PAGE = 250
export const PACK_PUBLISHED_TOPIC = 'asset.pack.published'

export interface IndustryAssetPublicationDependencies {
  readonly workspaces: IndustryWorkspaceStore
  readonly validations: IndustryValidationReportStore
  readonly definitionCandidates: AssetCandidateStore
  readonly ruleActions: RuleActionCandidateStore
  readonly syntheticSets: SyntheticExampleSetStore
  readonly definitions: SemanticDefinitionStore
  readonly store: PublishedPackAssetStore
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new IndustryAssetPublicationError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may publish an industry pack',
  )
}

function requireRevision(revision: string | undefined): string {
  if (revision === undefined) {
    throw new IndustryAssetPublicationError('VERSION_CONFLICT', 'an If-Match revision is required to publish a pack')
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new IndustryAssetPublicationError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function publicationAudit(
  definition: SemanticDefinitionRecord,
  actor: string,
  occurredAt: string,
  idempotencyKey: string,
): SemanticDefinitionAudit {
  const payload = canonicalJson({
    namespace: definition.namespace,
    definitionId: definition.ref.id,
    version: definition.ref.version,
    digest: definition.ref.digest,
    layer: definition.layer,
    publishedAt: occurredAt,
    actor,
  })
  return {
    digest: definition.ref.digest,
    payloadDigest: sha256DigestOf(payload),
    idempotencyKey,
    occurredAt,
    actor,
  }
}

function currentActionCandidates(candidates: readonly RuleActionCandidateVersion[]): RuleActionCandidateVersion[] {
  const latest = new Map<string, RuleActionCandidateVersion>()
  for (const candidate of candidates) {
    if (candidate.lifecycle === 'rejected') continue
    const existing = latest.get(candidate.logicalId)
    if (existing === undefined || existing.recordedAt <= candidate.recordedAt) latest.set(candidate.logicalId, candidate)
  }
  return [...latest.values()].sort((left, right) => left.logicalId.localeCompare(right.logicalId))
}

export class IndustryAssetPublicationService {
  readonly #deps: IndustryAssetPublicationDependencies
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: IndustryAssetPublicationDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async publish(
    workspaceId: Uuid,
    input: PublishIndustryPackInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const expected = requireRevision(input.expectedRevision)
    const scopeRef = scopeOf(ctx)

    const workspace = await this.#deps.workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new IndustryAssetPublicationError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }

    const replay = await this.#deps.store.findByIdempotencyKey(scopeRef, key, ctx)
    if (replay !== undefined) return replay

    if (workspace.headRevision !== expected) {
      throw new IndustryAssetPublicationError(
        'VERSION_CONFLICT',
        `workspace head is ${workspace.headRevision}, not the expected ${expected}`,
      )
    }

    const report = await this.#deps.validations.get(scopeRef, workspaceId, input.validationId, ctx)
    if (report === undefined) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_NOT_FOUND',
        `validation ${input.validationId} is not visible in this workspace`,
      )
    }
    if (report.revision !== workspace.headRevision) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_STALE',
        `validation ${input.validationId} was recorded at revision ${report.revision}, not the current head ${workspace.headRevision}`,
      )
    }
    if (!report.semanticPublished.passed) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_BLOCKED',
        `the draft for workspace ${workspaceId} failed semantic validation and was not published`,
        { reasons: report.semanticPublished.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`) },
      )
    }
    if (input.requireDeploymentExecutable === true && !report.deploymentExecutable.passed) {
      throw new IndustryAssetPublicationError(
        'VALIDATION_BLOCKED',
        `the draft for workspace ${workspaceId} is not fully deployment-executable`,
        { reasons: report.deploymentExecutable.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`) },
      )
    }

    const candidates = await this.#deps.definitionCandidates.listCandidates(scopeRef, workspaceId, {}, ctx)
    const projection = currentDefinitionProjection(candidates)
    if (projection.length === 0) {
      throw new IndustryAssetPublicationError('DRAFT_NOT_FOUND', `workspace ${workspaceId} has no definition candidate to publish`)
    }

    const ruleActionCandidates = currentActionCandidates(
      await this.#deps.ruleActions.list(scopeRef, workspaceId, { limit: CANDIDATE_PAGE }, ctx),
    )

    const syntheticExampleRef = await this.#syntheticRef(report, scopeRef, workspaceId, ctx)
    const previous = await this.#previousPublished(scopeRef, workspace.namespace, input.packId, input.version, ctx)
    const publishedAt = this.#now()

    const { definition, asset } = assemblePack({
      workspace,
      scopeRef,
      packId: input.packId,
      version: input.version,
      definitionId: `${workspace.namespace}.${input.packId}`,
      projection,
      ruleActions: ruleActionCandidates,
      report,
      ...(syntheticExampleRef === undefined ? {} : { syntheticExampleRef }),
      ...(previous === undefined ? {} : { previous }),
      publishedAt,
      idempotencyKey: key,
      actor,
    })

    const violations = findIndustryPackViolations(asset.packAsset)
    if (violations.length > 0) {
      throw new IndustryAssetPublicationError(
        'EXPORT_LEAK_DETECTED',
        `published pack ${asset.packRef.id}@${asset.packRef.version} would leak ${violations.length} non-declaration value(s)`,
        { reasons: violations.map((violation) => `${violation.path} (${violation.code})`) },
      )
    }

    await this.#guardExisting(scopeRef, asset.namespace, asset.packRef, ctx)

    const outboxId = this.#newId()
    const outboxJobId = this.#newId()
    const outbox: NewOutboxMessage = {
      outboxId,
      topic: PACK_PUBLISHED_TOPIC,
      payload: {
        packRef: asset.packRef,
        packId: asset.packRef.id,
        version: asset.packRef.version,
        namespace: asset.namespace,
        workspaceId,
      },
      idempotencyKey: `pack-publish:${asset.namespace}:${asset.packRef.id}:${asset.packRef.version}`,
      availableAt: publishedAt,
      createdAt: publishedAt,
    }

    try {
      const result = await this.#deps.store.commitApprovedPack(
        scopeRef,
        {
          expectedRevision: expected,
          definition,
          definitionAudit: publicationAudit(
            definition,
            actor,
            publishedAt,
            `definition-publish:${definition.namespace}:${definition.ref.id}:${definition.ref.version}`,
          ),
          pack: asset,
          idempotencyKey: key,
          requestDigest: sha256DigestOf(
            canonicalJson({
              workspaceId,
              packId: input.packId,
              version: input.version,
              validationId: input.validationId,
              head: expected,
              contentDigest: asset.contentDigest,
            }),
          ),
          actor,
          recordedAt: publishedAt,
          outbox,
          outboxJobId,
        },
        ctx,
      )
      return result.asset
    } catch (error) {
      throw mapStoreError(error, asset.packRef)
    }
  }

  async getPublished(
    scopeRef: ScopeRef,
    packId: string,
    version: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    return this.#deps.store.findPack(scopeRef, packId, version, ctx)
  }

  async listPublished(
    scopeRef: ScopeRef,
    namespace: string | undefined,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset[]> {
    return this.#deps.store.listPacks(scopeRef, namespace === undefined ? {} : { namespace }, ctx)
  }

  async #syntheticRef(
    report: IndustryValidationReport,
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<ResourceRef | undefined> {
    const set = await this.#deps.syntheticSets.get(scopeRef, workspaceId, report.exampleSetId, ctx)
    if (set === undefined) return undefined
    return { id: set.exampleSetId, version: '1.0.0', digest: set.contentDigest, kind: 'dataset' }
  }

  async #previousPublished(
    scopeRef: ScopeRef,
    namespace: string,
    packId: string,
    version: string,
    ctx: ToolContext,
  ): Promise<{ readonly definition: SemanticDefinitionRecord; readonly asset: PublishedPackAsset } | undefined> {
    const published = await this.#deps.store.listPacks(scopeRef, { namespace, limit: DEFAULT_PAGE }, ctx)
    const candidates = published
      .filter((asset) => !(asset.packRef.id === packId && asset.packRef.version === version))
      .sort((left, right) => (left.publishedAt < right.publishedAt ? 1 : left.publishedAt > right.publishedAt ? -1 : 0))
    const prior = candidates[0]
    if (prior === undefined) return undefined
    const definitionVersion = await this.#deps.definitions.findVersion(
      namespace,
      prior.definitionRef.id,
      prior.definitionRef.version,
      scopeRef,
      ctx,
    )
    if (definitionVersion === undefined) return undefined
    return { definition: definitionRecordOf(definitionVersion), asset: prior }
  }

  async #guardExisting(
    scopeRef: ScopeRef,
    namespace: string,
    packRef: VersionRef,
    ctx: ToolContext,
  ): Promise<void> {
    const samePack = await this.#deps.store.findPack(scopeRef, packRef.id, packRef.version, ctx)
    if (samePack !== undefined && samePack.packRef.digest !== packRef.digest) {
      throw new IndustryAssetPublicationError(
        'PACK_VERSION_EXISTS',
        `pack ${packRef.id}@${packRef.version} is already published with a different digest`,
      )
    }
    const peers = await this.#deps.store.listPacks(scopeRef, { namespace, limit: DEFAULT_PAGE }, ctx)
    const conflict = peers.find(
      (asset) => asset.packRef.version === packRef.version && asset.packRef.digest !== packRef.digest,
    )
    if (conflict !== undefined) {
      throw new IndustryAssetPublicationError(
        'NAMESPACE_CONFLICT',
        `namespace ${namespace} already publishes version ${packRef.version} with a different digest`,
      )
    }
  }
}

function mapStoreError(error: unknown, packRef: VersionRef): IndustryAssetPublicationError {
  if (error instanceof PublishedPackAssetStoreError) {
    switch (error.code) {
      case 'SCOPE_MISMATCH':
        return new IndustryAssetPublicationError('SCOPE_MISMATCH', error.message, { cause: error })
      case 'VERSION_CONFLICT':
        return new IndustryAssetPublicationError('VERSION_CONFLICT', error.message, { cause: error })
      case 'IDEMPOTENCY_CONFLICT':
        return new IndustryAssetPublicationError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
      case 'PACK_VERSION_EXISTS':
      case 'DEFINITION_VERSION_EXISTS':
        return new IndustryAssetPublicationError('PACK_VERSION_EXISTS', error.message, { cause: error })
      case 'NAMESPACE_CONFLICT':
        return new IndustryAssetPublicationError('NAMESPACE_CONFLICT', error.message, { cause: error })
      case 'WORKSPACE_NOT_FOUND':
        return new IndustryAssetPublicationError('WORKSPACE_NOT_FOUND', error.message, { cause: error })
      default:
        return new IndustryAssetPublicationError(
          'STORE_FAILED',
          `publishing ${packRef.id}@${packRef.version} failed`,
          { cause: error },
        )
    }
  }
  if (error instanceof IndustryAssetPublicationError) return error
  return new IndustryAssetPublicationError(
    'STORE_FAILED',
    `publishing ${packRef.id}@${packRef.version} failed`,
    { cause: error },
  )
}
