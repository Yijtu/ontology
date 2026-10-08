import type { IdentityDecisionStore, MaterializationStore, ProjectDocumentStore, ProjectFactSourcePin, ProjectRecordStore, ProjectRevisionRef, ProjectStore, PublishedRuleDeclarationReader, PublishedStatement, RulePremiseReplayPort, SemanticPublicationStore, ToolContext } from '@ontology/contracts'
import { assertProjectFactInputShape, isRecord } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { definitionVersionDigest } from '../definitions/validate'
import { compilePublishedRuleInstances, projectPublishedAttributeFacts, projectPublishedRelationFacts, publishedRuleRef, RuleEvaluator } from '../rules'
import { publishedSemanticComputationRules } from '../materialization/published-source'
import { ruleComputationArtifactOf } from '../materialization/artifacts'
import { isRuleComputationArtifact } from './materialized-support-reader'
import { rulePremiseSourceTargetsOf, verifyRulePremiseSources } from './rule-premise-sources'
import type { RulePremiseSourceDependencies } from './rule-premise-sources'

export interface RulePremiseReplayDependencies extends RulePremiseSourceDependencies {
  readonly materialization: Pick<MaterializationStore, 'readSlices'>
  readonly publications: Pick<SemanticPublicationStore, 'getPublication' | 'getStatementRevision' | 'getStatement' | 'listRuleVersions'>
  /** Host-selected only after resolving an authorized immutable historical run binding. */
  readonly readMode?: 'current' | 'published_snapshot'
  readonly publishedRules?: PublishedRuleDeclarationReader
  readonly maxSlices?: number
  readonly identity: Pick<IdentityDecisionStore, 'readPublishedBindings'>
  readonly projects?: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly projectDocuments?: Pick<ProjectDocumentStore, 'getMembership' | 'getVisibility'>
  readonly records?: Pick<ProjectRecordStore, 'getRecord'>
}

const equal = (left: unknown, right: unknown): boolean => sha256DigestOf(left) === sha256DigestOf(right)
const statementIdentity = (statement: PublishedStatement): unknown => ({ ...statement, recordedAt: new Date(statement.recordedAt).toISOString(),
  ...(statement.validFrom === undefined ? {} : { validFrom: new Date(statement.validFrom).toISOString() }),
  ...(statement.validTo === undefined ? {} : { validTo: new Date(statement.validTo).toISOString() }),
})
const sameStatement = (left: PublishedStatement | undefined, right: PublishedStatement): boolean => left !== undefined && equal(statementIdentity(left), statementIdentity(right))

/** Recompiles actual frozen published declarations, never applicability or a saved compiled AST. */
export class ArchivedRulePremiseReplayVerifier implements RulePremiseReplayPort {
  readonly #deps: RulePremiseReplayDependencies
  constructor(deps: RulePremiseReplayDependencies) { this.#deps = deps }

  async verify(input: { readonly artifact: unknown; readonly payload: unknown }, ctx: ToolContext): Promise<boolean> {
    const candidate = input.artifact
    if (!isRuleComputationArtifact(candidate) || candidate.validAt === undefined || candidate.asOfRecordedSeq === undefined || candidate.scopeRef.tenantId !== ctx.principal.tenantId || candidate.scopeRef.spaceId !== ctx.allowedResources.spaceId) return false
    const scope = candidate.scopeRef
    const cap = this.#deps.maxSlices ?? 10_000
    if (!Number.isSafeInteger(cap) || cap < 1) return false
    const slices = await this.#deps.materialization.readSlices(scope, { validAt: candidate.validAt, asOfRecordedSeq: candidate.asOfRecordedSeq, limit: cap + 1 }, ctx)
    if (slices.length > cap) return false
    const selected = slices.flatMap((slice) => slice.recordedSeq === candidate.asOfRecordedSeq ? (slice.conclusion.ruleArtifacts ?? []).map((artifact) => ({ artifact, slice })) : [])
      .find(({ artifact }) => artifact.instanceKey === candidate.instanceKey && equal(artifact, candidate))
    const saved = selected?.artifact
    if (saved === undefined || saved.premiseInput === undefined || !saved.complete) return false
    const archive = saved.premiseInput
    if (!archive.complete || archive.declarations.length > 250 || archive.facts.length > 10_000 || archive.evaluatedRuleIds.length > 10_000 ||
      archive.request.validAt !== saved.validAt || archive.request.asOfRecordedSeq !== saved.asOfRecordedSeq || !equal(archive.request.scopeRef, scope)) return false
    const currentIdentityMatches = async (): Promise<boolean> => {
      if (archive.identityBindings.length > 1_000) return false
      const actual = await this.#deps.identity.readPublishedBindings(scope, archive.identityBindings.map((binding) => binding.candidateId), ctx)
      return actual.complete && equal([...actual.bindings].sort((a, b) => a.candidateId.localeCompare(b.candidateId)), [...archive.identityBindings].sort((a, b) => a.candidateId.localeCompare(b.candidateId)))
    }
    if (this.#deps.readMode !== 'published_snapshot' && !await currentIdentityMatches()) return false
    const used = new Set<string>()
    const pending = [saved.ruleRef]
    while (pending.length > 0) {
      const ref = pending.pop()
      if (ref === undefined || used.has(sha256DigestOf(ref))) continue
      used.add(sha256DigestOf(ref))
      const declaration = archive.declarations.find((row) => equal(publishedRuleRef(row), ref))
      if (declaration === undefined) return false
      pending.push(...(declaration.dependencyRefs ?? []).map((dependency) => dependency.ruleRef))
    }
    const currentExtractedRulesMatch = async (): Promise<boolean> => {
      const declarations = archive.declarations.filter((row) => !('publishedPackRef' in row) && used.has(sha256DigestOf(publishedRuleRef(row))))
      for (const declaration of declarations) {
        const rows = await this.#deps.publications.listRuleVersions(scope, { objectId: declaration.objectId, limit: 251 }, ctx)
        if (rows.length > 250) return false
        for (const row of rows) if (row.ruleId === declaration.ruleId && row.projectId === declaration.projectId && BigInt(row.version) > BigInt(declaration.version)) {
          const publication = await this.#deps.publications.getPublication(scope, row.publicationId, ctx)
          if (publication === undefined || equal(publication.schemaRef, saved.definitionRef)) return false
        }
      }
      return true
    }
    if (this.#deps.readMode !== 'published_snapshot' && !await currentExtractedRulesMatch()) return false
    const definition = archive.definition
    if (definition !== undefined && (!equal(definition.scopeRef, scope) || !equal(definition.ref, saved.definitionRef) || definitionVersionDigest(definition) !== saved.definitionRef.digest)) return false

    // The append-only slice establishes the historical admission point. This host-only reader
    // validates frozen full bodies and approval/enablement pins, even after current withdrawal.
    const packs = new Map<string, Awaited<ReturnType<PublishedRuleDeclarationReader['read']>>>()
    let projectRevisionRef: ProjectRevisionRef | undefined
    if (saved.projectId !== undefined) {
      const provenance = archive.attributeStatements.find((statement) => isRecord(statement.value['provenance']))?.value['provenance']
      try { assertProjectFactInputShape(provenance) } catch { return false }
      projectRevisionRef = provenance.sources[0]?.projectRevisionRef
      if (projectRevisionRef?.projectId !== saved.projectId || !provenance.sources.every((source) => source.projectRevisionRef.projectId === saved.projectId)) return false
    }
    const currentProjectSourcesMatch = async (): Promise<boolean> => {
      if (saved.projectId === undefined) return true
      if (this.#deps.projects === undefined || this.#deps.projectDocuments === undefined || this.#deps.records === undefined) return false
      const project = await this.#deps.projects.getProject(scope, saved.projectId, ctx)
      if (project === undefined || project.state === 'archived') return false
      // Legacy stores have one head; staging-capable stores explicitly select their active head.
      const activeRevision = 'activeRevision' in project ? project.activeRevision : project.headRevision
      if (typeof activeRevision !== 'string') return false
      const active = await this.#deps.projects.getRevision(scope, saved.projectId, activeRevision, ctx)
      const visibility = await this.#deps.projectDocuments.getVisibility(scope, saved.projectId, ctx)
      if (active === undefined || visibility === undefined || !equal(active.definitionRef, saved.definitionRef)) return false
      const sources: ProjectFactSourcePin[] = []
      for (const statement of [...archive.attributeStatements, ...archive.relationStatements]) {
        const provenance = statement.value['provenance']
        try { assertProjectFactInputShape(provenance) } catch { return false }
        sources.push(...provenance.sources)
      }
      for (const pin of new Map(sources.map((source) => [sha256DigestOf(source), source])).values()) {
        const original = await this.#deps.projects.getRevision(scope, saved.projectId, pin.projectRevisionRef.revision, ctx)
        if (pin.projectRevisionRef.projectId !== saved.projectId || original === undefined || !equal(original.ref, pin.projectRevisionRef) || !equal(original.definitionRef, pin.definitionRef) ||
          !equal(pin.definitionRef, saved.definitionRef) || !original.mappingRefs.some((ref) => equal(ref, pin.mappingRef)) || !active.mappingRefs.some((ref) => equal(ref, pin.mappingRef))) return false
        const membership = await this.#deps.projectDocuments.getMembership(scope, saved.projectId, pin.documentId, ctx)
        const record = await this.#deps.records.getRecord(scope, saved.projectId, pin.recordId, ctx)
        if (membership?.state !== 'active' || membership.membershipRevision !== pin.membershipRevision || membership.parseId !== pin.parseId || visibility.epoch !== pin.visibilityEpoch ||
          record === undefined || record.revision !== pin.recordRevision || record.contentDigest !== pin.contentDigest || record.sourceDigest !== pin.sourceDigest || record.status !== 'confirmed') return false
      }
      return true
    }
    if (this.#deps.readMode !== 'published_snapshot' && !await currentProjectSourcesMatch()) return false
    for (const declaration of archive.declarations) {
      if ('publishedPackRef' in declaration) {
        const key = sha256DigestOf(declaration.publishedPackRef)
        let actual = packs.get(key)
        if (actual === undefined) {
          if (this.#deps.publishedRules === undefined) return false
          actual = await this.#deps.publishedRules.read(scope, { packRef: declaration.publishedPackRef, definitionRef: saved.definitionRef, readMode: this.#deps.readMode ?? 'current',
            ...(saved.projectId === undefined ? {} : { projectId: saved.projectId }), ...(projectRevisionRef === undefined ? {} : { projectRevisionRef }) }, ctx)
          packs.set(key, actual)
        }
        if (!actual.some((row) => equal(row, declaration))) return false
      } else {
        const publication = await this.#deps.publications.getPublication(scope, declaration.publicationId, ctx)
        if (publication === undefined || !equal(publication.schemaRef, saved.definitionRef) || !publication.ruleVersions.some((row) => equal(row, declaration))) return false
      }
    }
    // Re-read the immutable publication and its exact revision events; latest heads are not
    // historical input authority. Then independently project values and relation endpoints.
    for (const statement of [...archive.attributeStatements, ...archive.relationStatements]) {
      const publication = await this.#deps.publications.getPublication(scope, statement.publicationId, ctx)
      let actual = publication?.statements.find((row) => row.statementId === statement.statementId)
      if (actual === undefined || !equal(publication?.schemaRef, saved.definitionRef) || !/^[1-9]\d*$/.test(statement.version) || BigInt(statement.version) > 256n) return false
      for (let revision = BigInt(actual.version) + 1n; revision <= BigInt(statement.version); revision++) {
        const event = await this.#deps.publications.getStatementRevision(scope, statement.statementId, String(revision), ctx)
        if (event === undefined) return false
        actual = { ...actual, version: event.version, status: event.kind === 'retraction' ? 'retracted' : 'active', value: event.correctedValue ?? actual.value,
          ...(event.validFrom === undefined ? {} : { validFrom: event.validFrom }), ...(event.validTo === undefined ? {} : { validTo: event.validTo }) }
      }
      if (!sameStatement(actual, statement)) return false
      if (this.#deps.readMode !== 'published_snapshot' && !sameStatement(await this.#deps.publications.getStatement(scope, statement.statementId, ctx), statement)) return false
    }
    const projected = projectPublishedAttributeFacts(archive.attributeStatements, { schemaRef: saved.definitionRef, scopeRef: scope,
      ...(saved.projectId === undefined ? {} : { projectId: saved.projectId }), ...(definition === undefined ? {} : { definition }) })
    const relations = definition === undefined ? { facts: [], issues: [] } : projectPublishedRelationFacts(archive.relationStatements, { definition, bindings: archive.identityBindings })
    if (projected.issues.length !== 0 || relations.issues.length !== 0 || !equal([...projected.facts, ...relations.facts], archive.facts)) return false
    const compiled = compilePublishedRuleInstances(archive.declarations, archive.facts, { scopeRef: scope, definitionRef: saved.definitionRef, subjects: archive.subjects,
      completeRangeAttributeIds: archive.completeRangeAttributeIds, ...(definition === undefined ? {} : { definition }), ...(saved.projectId === undefined ? {} : { projectId: saved.projectId }) })
    const usedVersions = new Set(archive.declarations.filter((row) => used.has(sha256DigestOf(publishedRuleRef(row)))).map((row) => row.ruleVersionId))
    if (compiled.issues.some((issue) => usedVersions.has(issue.ruleVersionId))) return false
    const composed = publishedSemanticComputationRules(compiled, archive.declarations, scope, saved.definitionRef, saved.projectId)
    if (composed.invalidConclusionRules.length !== 0) return false
    const rules = composed.rules.filter((rule) => archive.evaluatedRuleIds.includes(rule.ruleId))
    if (rules.length !== archive.evaluatedRuleIds.length) return false
    const recomputed = new RuleEvaluator().evaluate({ scopeRef: scope, definitionRef: saved.definitionRef, request: archive.request, facts: archive.facts, rules, complete: archive.complete })
    const result = recomputed.applicabilities.find((row) => row.instanceKey === saved.instanceKey)
    if (result === undefined) return false
    const { premiseInput: omitted, ...expected } = saved
    void omitted
    if (selected === undefined || !equal(ruleComputationArtifactOf(result, rules), expected) || !await verifyRulePremiseSources(saved, input.payload, this.#deps, ctx, rulePremiseSourceTargetsOf(selected.slice, saved))) return false
    // Detect withdrawals during source reads, before returning a successful hard verification.
    if (this.#deps.readMode !== 'published_snapshot') {
      if (!await currentIdentityMatches()) return false
      if (!await currentProjectSourcesMatch()) return false
      if (!await currentExtractedRulesMatch()) return false
      for (const statement of [...archive.attributeStatements, ...archive.relationStatements]) if (!sameStatement(await this.#deps.publications.getStatement(scope, statement.statementId, ctx), statement)) return false
      for (const declaration of archive.declarations) if ('publishedPackRef' in declaration) {
        const rows = await this.#deps.publishedRules?.read(scope, { packRef: declaration.publishedPackRef, definitionRef: saved.definitionRef,
          ...(saved.projectId === undefined ? {} : { projectId: saved.projectId }) }, ctx)
        if (!rows?.some((row) => equal(row, declaration))) return false
      }
    }
    return true
  }
}
