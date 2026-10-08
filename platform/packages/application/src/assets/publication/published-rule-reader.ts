import { IndustryAssetPublicationError, assertPublishedPackAssetShape, assertRuleDependencyCandidateShape, isToolContext } from '@ontology/contracts'
import type { ComponentRegistryStore, ProjectStore, PublishedDefinitionVersionReader, PublishedPackAssetStore, PublishedPackRuleVersion, PublishedRuleDeclarationReader, PublishedRuleDeclarationRequest, ReviewableCandidateReader, RuleActionCandidateStore, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { canonicalJson } from '../../profiles/canonical'
import { contentDigestOf, publishedPackContentDigest } from './pack-assembly'
import { ruleApprovalPins } from './publication-pins'
import type { CandidateApprovalReader } from './publication-pins'
import { DynamicDefinitionTerminologySource } from '../definition-candidates/dynamic-terminology'
import { StoreBackedIndustryPackCatalogue } from '../../packages/dynamic-catalogue'

export interface PublishedPackRuleReaderDependencies {
  readonly packs: PublishedPackAssetStore
  readonly registry: Pick<ComponentRegistryStore, 'findVersion'>
  readonly definitions: PublishedDefinitionVersionReader
  readonly candidates: RuleActionCandidateStore
  readonly reviews: CandidateApprovalReader
  readonly reviewableCandidates: ReviewableCandidateReader
  readonly projects?: Pick<ProjectStore, 'getProject' | 'getRevision'>
}
const sameRef = (a: VersionRef, b: VersionRef): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest

/** Reads only complete declarations frozen by the normal reviewed, enabled pack publication. */
export class PublishedPackRuleDeclarationReader implements PublishedRuleDeclarationReader {
  readonly #deps: PublishedPackRuleReaderDependencies
  constructor(deps: PublishedPackRuleReaderDependencies) { this.#deps = deps }

  async read(scope: ScopeRef, request: PublishedRuleDeclarationRequest, ctx: ToolContext): Promise<readonly PublishedPackRuleVersion[]> {
    const blocked = (message: string): never => { throw new IndustryAssetPublicationError('VALIDATION_BLOCKED', message) }
    if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) blocked('published rule scope disagrees with the trusted context')
    const asset = await this.#deps.packs.findByRef(scope, request.packRef, ctx)
    if (asset === undefined) return blocked('the exact published pack is not visible')
    assertPublishedPackAssetShape(asset)
    if (!sameRef(asset.packRef, request.packRef) || !sameRef(asset.definitionRef, request.definitionRef) || asset.contentDigest !== request.packRef.digest ||
      publishedPackContentDigest(asset) !== asset.contentDigest || asset.ruleDeclarations === undefined ||
      contentDigestOf(asset.ruleDeclarations) !== asset.manifest.rulePolicyRef.digest || asset.packAsset.ruleDeclarationsRef?.digest !== asset.manifest.rulePolicyRef.digest) blocked('published rule bodies or exact pack/definition pins disagree')
    const historical = request.readMode === 'published_snapshot'
    if (!historical) {
      // Reuse the normal current-pack authorization, exact-definition and registry lifecycle gate.
      await new DynamicDefinitionTerminologySource({ catalogue: new StoreBackedIndustryPackCatalogue({ store: this.#deps.packs }), definitions: this.#deps.definitions,
        registry: this.#deps.registry, publishedPacks: this.#deps.packs }).getTerminology(scope, request.packRef, ctx).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && ['FORBIDDEN', 'VALIDATION_BLOCKED', 'SCHEMA_NOT_FOUND', 'VERSION_CONFLICT'].includes(String(error.code))) return blocked(error.message)
          throw error
        })
      const peers = await this.#deps.packs.listPacks(scope, { namespace: asset.namespace, limit: 250 }, ctx)
      if (peers.length === 250 || peers.some((peer) => peer.strategy?.kind === 'retire_previous' && peer.strategy.supersedesRef !== undefined && sameRef(peer.strategy.supersedesRef, asset.definitionRef))) blocked('published rule pack is retired or retirement coverage is incomplete')
    }
    if (request.projectId !== undefined) {
      const project = await this.#deps.projects?.getProject(scope, request.projectId, ctx)
      const projectRevision = historical ? request.projectRevisionRef?.revision : project?.headRevision
      const revision = projectRevision === undefined ? undefined : await this.#deps.projects?.getRevision(scope, request.projectId, projectRevision, ctx)
      if (project === undefined || !historical && project.state === 'archived' || revision === undefined || !sameRef(revision.industryPackRef, request.packRef) || !sameRef(revision.definitionRef, request.definitionRef) ||
        historical && (request.projectRevisionRef?.projectId !== request.projectId || request.projectRevisionRef.digest !== revision.ref.digest)) blocked('project does not pin this exact active or historical pack and definition')
    }
    const rows = historical ? [] : await this.#deps.candidates.list(scope, asset.workspaceId, { limit: 250 }, ctx)
    if (rows.length === 250) blocked('rule candidate current-revision read is incomplete')
    // New unpublished proposals cannot revoke P1. Only P1's own explicit withdrawal/review or
    // published-version lifecycle blocks execution of a project still pinned to P1.
    const active = rows.filter((candidate) => candidate.kind === 'rule' && asset.ruleDeclarations?.some((declaration) => declaration.candidateId === candidate.candidateId))
    const pins = historical ? asset.ruleReviewPins ?? [] : await ruleApprovalPins(active, scope, ctx, this.#deps.reviewableCandidates, this.#deps.reviews).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && ['VERSION_CONFLICT', 'AMBIGUOUS_CANDIDATE', 'SCOPE_MISMATCH'].includes(String(error.code))) return blocked(error.message)
      throw error
    })
    const frozenPins = asset.ruleReviewPins ?? []
    if (pins.length !== frozenPins.length || pins.some((pin) => !frozenPins.some((frozen) => frozen.candidateId === pin.candidateId && frozen.contentDigest === pin.contentDigest)) ||
      !historical && active.length !== asset.ruleDeclarations?.length || (asset.ruleDeclarations ?? []).some((row) => !frozenPins.some((pin) =>
        pin.candidateId === row.candidateId && pin.contentDigest === row.contentDigest && pin.reviewRevision === row.reviewRevision))) blocked('published rule enablement or approval has been replaced/withdrawn')
    const rules: PublishedPackRuleVersion[] = []
    for (const declaration of asset.ruleDeclarations ?? []) {
      const candidate = active.find((row) => row.candidateId === declaration.candidateId)
      if (!historical && (candidate?.kind !== 'rule' || candidate.lifecycle !== 'enabled' || candidate.enabledAt !== declaration.enabledAt || candidate.contentDigest !== declaration.contentDigest ||
        canonicalJson(candidate.payload) !== canonicalJson(declaration.payload) || canonicalJson(candidate.sourceRefs) !== canonicalJson(declaration.sourceRefs) ||
        canonicalJson(candidate.sourceSpans) !== canonicalJson(declaration.sourceSpans) || canonicalJson(candidate.generationCallRef) !== canonicalJson(declaration.generationCallRef))) blocked('published rule declaration differs from its current immutable candidate')
      const payload = declaration.payload
      assertRuleDependencyCandidateShape(payload.ruleDependencies, payload.dependencyRefs ?? [])
      rules.push({ ruleVersionId: declaration.candidateId, ruleId: payload.ruleId, version: asset.revision, objectId: payload.applicability.objectId,
        severity: 'soft', impact: 'low', expression: payload.condition, exceptions: payload.exceptions,
        ...(payload.conclusion === undefined ? {} : { conclusion: payload.conclusion }), ruleDependencies: payload.ruleDependencies,
        dependencyRefs: (payload.dependencyRefs ?? []).map((ref) => {
          if (ref.definitionRef !== undefined && !sameRef(ref.definitionRef, request.definitionRef) || ref.scopeRef !== undefined && (ref.scopeRef.tenantId !== scope.tenantId || ref.scopeRef.spaceId !== scope.spaceId) ||
            ref.projectId !== undefined && ref.projectId !== request.projectId || ref.publishedPackRef !== undefined && !sameRef(ref.publishedPackRef, request.packRef)) blocked('rule dependency points outside the exact project/publication origin')
          return { ...ref, scopeRef: scope, definitionRef: request.definitionRef, publishedPackRef: request.packRef, ...(request.projectId === undefined ? {} : { projectId: request.projectId }) }
        }),
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(payload.applicability.validFrom === undefined ? {} : { validFrom: payload.applicability.validFrom }),
        ...(payload.applicability.validTo === undefined ? {} : { validTo: payload.applicability.validTo }),
        recordedAt: asset.publishedAt, sourceCandidateId: declaration.candidateId, publishedPackRef: asset.packRef,
        ruleRef: { id: declaration.candidateId, version: '1.0.0', digest: declaration.contentDigest } })
    }
    return rules
  }
}
