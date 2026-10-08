import type {
  PublishedRuleFilter,
  SemanticDefinitionVersion,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
  PublishedExecutableRule,
  PublishedRuleDeclarationReader,
  PublishedRuleDeclarationRequest,
} from '@ontology/contracts'
import type { IdentityDecisionStore, IdentityPublishedBindingSnapshot } from '@ontology/contracts'
import { IndustryAssetPublicationError } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import {
  compilePublishedRuleInstances,
  projectPublishedAttributeFacts,
  projectPublishedRelationFacts,
  publishedStatementProjectId,
  isRuleDecimalValue,
  isRuleScalarDecimalValue,
} from '../rules'
import type { DependencyEntityBinding } from './dependency-index'
import type { SupportRule } from '../rules'
import { readAllPublishedRules, readAllPublishedStatements, readAtStableRevision } from './published-pages'
import type { PublishedPageLimits } from './published-pages'
import type {
  MaterializationPublishedSource,
  PublishedSemanticData,
} from './types'

/**
 * The official published read API required by the materializer. The API adapter may satisfy it
 * structurally; this package does not import an adapter or driver.
 */
export interface PublishedSemanticReadView {
  latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString>
  getPublication(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<{ readonly schemaRef: VersionRef } | undefined>
  listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilter,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]>
  listRuleVersions(
    scopeRef: ScopeRef,
    filter: PublishedRuleFilter,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]>
}

export interface PublishedSemanticSourceOptions extends PublishedPageLimits {
  readonly publishedRules?: { readonly reader: PublishedRuleDeclarationReader; readonly request: PublishedRuleDeclarationRequest }
  readonly projectId?: string
  /** The run/profile pin. A multi-schema scope must provide an exact definition version. */
  readonly definitionRef?: VersionRef
  /** Exact immutable schema supplying executable relation declarations. */
  readonly definition?: SemanticDefinitionVersion
  /** Required by the production worker; omission is retained for bounded unit fixtures. */
  readonly identity?: Pick<IdentityDecisionStore, 'latestReadRevision' | 'readPublishedBindings'>
  readonly completeRangeAttributeIds?: readonly string[]
}

const DEFAULT_PAGE_SIZE = 1_000
const DEFAULT_MAX_RECORDS = 100_000
const IDENTITY_BATCH_SIZE = 1_000
const IDENTITY_READ_CONCURRENCY = 4

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function compareRevision(left: RevisionString, right: RevisionString): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

async function mapBounded<T, R>(items: readonly T[], width: number, visit: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  for (let offset = 0; offset < items.length; offset += width) {
    const page = items.slice(offset, offset + width)
    const results = await Promise.all(page.map(visit))
    results.forEach((value, index) => { output[offset + index] = value })
  }
  return output
}

function ruleKey(rule: PublishedExecutableRule): string {
  return `${rule.ruleId}\u0000${rule.objectId}`
}

function businessPropositionKey(scopeRef: ScopeRef, definitionRef: VersionRef, subjectEntityId: string, objectId: string, predicate: string, projectId?: string): string {
  return `business-conclusion:${sha256DigestOf({ scopeRef, definitionRef, subjectEntityId, objectId, predicate, ...(projectId === undefined ? {} : { projectId }) })}`
}

function hasValidStoredConclusion(rule: PublishedExecutableRule): boolean {
  const binding = rule.conclusion
  if (binding === undefined) return true
  if (typeof binding.predicate !== 'string' || binding.predicate.length === 0) return false
  if (typeof binding.value === 'string' || typeof binding.value === 'boolean') return true
  return isRuleDecimalValue(binding.value) || isRuleScalarDecimalValue(binding.value)
}

/**
 * Current published semantic snapshot used by materialisation and read bridges. It projects
 * immutable entity statements into per-attribute facts, checks their adjudicated identity
 * bindings, pins one definition version, and compiles only rules for matching entity/schema.
 */
export class PublishedSemanticSource implements MaterializationPublishedSource {
  readonly #readView: PublishedSemanticReadView
  readonly #identity: Pick<IdentityDecisionStore, 'latestReadRevision' | 'readPublishedBindings'> | undefined
  readonly #definitionRef: VersionRef | undefined
  readonly #definition: SemanticDefinitionVersion | undefined
  readonly #pageLimits: PublishedPageLimits
  readonly #completeRangeAttributeIds: readonly string[]
  readonly #projectId: string | undefined
  readonly #publishedRules: PublishedSemanticSourceOptions['publishedRules']

  constructor(readView: PublishedSemanticReadView, options: PublishedSemanticSourceOptions = {}) {
    this.#readView = readView
    this.#identity = options.identity
    this.#definition = options.definition
    this.#definitionRef = options.definitionRef ?? options.definition?.ref
    this.#pageLimits = {
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS,
    }
    this.#completeRangeAttributeIds = options.completeRangeAttributeIds ?? []
    this.#projectId = options.projectId
    this.#publishedRules = options.publishedRules
  }

  async load(scopeRef: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const identity = this.#identity
    const readIdentityRevision = identity === undefined
      ? async (): Promise<RevisionString> => '0'
      : () => identity.latestReadRevision(scopeRef, ctx)
    const snapshot = await readAtStableRevision(
      this.#readView,
      readIdentityRevision,
      scopeRef,
      ctx,
      async () => {
        const [statements, ruleVersions] = await Promise.all([
          readAllPublishedStatements(this.#readView, scopeRef, ctx, {}, this.#pageLimits),
          readAllPublishedRules(this.#readView, scopeRef, ctx, {}, this.#pageLimits),
        ])
        const publicationIds = unique([
          ...statements.map((statement) => statement.publicationId),
          ...ruleVersions.map((rule) => rule.publicationId),
        ])
        const publications = new Map<Uuid, { readonly schemaRef: VersionRef } | undefined>()
        const publicationRows = await mapBounded(publicationIds, 8, async (id) => [
          id,
          await this.#readView.getPublication(scopeRef, id, ctx),
        ] as const)
        for (const [id, publication] of publicationRows) publications.set(id, publication)

        const issues: NonNullable<PublishedSemanticData['issues']>[number][] = []
        for (const id of publicationIds) {
          if (publications.get(id) === undefined) issues.push({ code: 'PUBLICATION_NOT_FOUND', message: `publication ${id} is missing for a published statement or rule` })
        }
        const schemaRefsByKey = new Map<string, VersionRef>()
        for (const [, publication] of publicationRows) {
          const ref = publication?.schemaRef
          if (ref !== undefined) schemaRefsByKey.set(`${ref.id}\u0000${ref.version}\u0000${ref.digest}`, ref)
        }
        const schemaRefs = [...schemaRefsByKey.values()]
        let definitionRef = this.#definitionRef
        if (definitionRef === undefined && schemaRefs.length === 1) definitionRef = schemaRefs[0]
        if (definitionRef === undefined && schemaRefs.length > 1) {
          issues.push({ code: 'DEFINITION_PIN_REQUIRED', message: 'published facts span multiple definition versions; a run/profile must pin one exact version' })
          return { facts: [], rules: [], entityBindings: [], complete: false, historicalAsOfSupported: false, issues }
        }
        if (definitionRef === undefined && schemaRefs.length === 0 && statements.length === 0 && ruleVersions.length === 0) {
          return { facts: [], rules: [], entityBindings: [], complete: true, historicalAsOfSupported: false, issues }
        }
        const inDefinition = <T extends { readonly publicationId: Uuid }>(record: T): boolean => {
          if (definitionRef === undefined) return false
          const publication = publications.get(record.publicationId)
          return publication !== undefined && sameVersion(publication.schemaRef, definitionRef)
        }
        const inProject = (statement: PublishedStatement): boolean => this.#projectId === undefined || publishedStatementProjectId(statement) === this.#projectId
        const scopedStatements = statements.filter((statement) => inDefinition(statement) && inProject(statement))
        const scopedRuleVersions = ruleVersions.filter((rule) => inDefinition(rule) && rule.projectId === this.#projectId)
        const identityBindings = await this.#readIdentityBindings(scopeRef, scopedStatements, ctx)
        if (identityBindings.issue !== undefined) issues.push(identityBindings.issue)
        const identityOf = new Map(identityBindings.bindings.map((binding) => [binding.candidateId, binding]))
        let unconfirmedIdentityCount = 0
        const validEntityStatements = scopedStatements.filter((statement) => {
          if (statement.kind !== 'entity') return false
          if (statement.objectId === undefined || statement.subjectEntityId === undefined) {
            unconfirmedIdentityCount += 1
            issues.push({
              code: 'PUBLISHED_ENTITY_SCOPE_MISSING',
              message: `published entity statement ${statement.statementId} has no objectId or subjectEntityId`,
              statementId: statement.statementId,
            })
            return false
          }
          // A retracted current head is retained as an explicit tombstone in the dependency
          // and fact streams, but it no longer asserts a positive identity or property value.
          // Historical identity is served from the verified answer/materialized history.
          if (statement.status === 'retracted') return true
          const binding = identityOf.get(statement.sourceCandidateId)
          const open = binding?.openAssertions ?? []
          const matches = open.filter((assertion) =>
            assertion.entityId === statement.subjectEntityId && assertion.objectId === statement.objectId,
          )
          const valid = open.length === 1 && matches.length === 1 && !binding?.cannotLinkEntityIds.includes(statement.subjectEntityId)
          if (!valid) {
            unconfirmedIdentityCount += 1
            issues.push({
              code: 'PUBLISHED_IDENTITY_UNCONFIRMED',
              message: `published entity statement ${statement.statementId} does not have one current confirmed identity binding`,
              subjectEntityId: statement.subjectEntityId,
              statementId: statement.statementId,
            })
          }
          return valid
        })

        if (definitionRef === undefined) {
          return {
            facts: [],
            rules: [],
            entityBindings: [],
            complete: !issues.some((issue) => issue.code === 'PUBLICATION_NOT_FOUND'),
            historicalAsOfSupported: false,
            issues,
          }
        }
        const allEntityStatements = scopedStatements.filter((statement): statement is PublishedStatement & { readonly objectId: string; readonly subjectEntityId: string } =>
          statement.kind === 'entity' && statement.objectId !== undefined && statement.subjectEntityId !== undefined,
        )
        const definition = this.#definition !== undefined && this.#definition.scopeRef.tenantId === scopeRef.tenantId && this.#definition.scopeRef.spaceId === scopeRef.spaceId && sameVersion(this.#definition.ref, definitionRef) ? this.#definition : undefined
        const projectionOptions = { schemaRef: definitionRef, scopeRef, ...(definition === undefined ? {} : { definition }), ...(this.#projectId === undefined ? {} : { projectId: this.#projectId }) }
        const projection = projectPublishedAttributeFacts(validEntityStatements, projectionOptions)
        const dependencyProjection = projectPublishedAttributeFacts(allEntityStatements, projectionOptions)
        for (const issue of dependencyProjection.issues) issues.push({
          code: issue.code,
          message: issue.message,
          statementId: issue.statementId,
        })
        // Keep one instance for every published entity/object even when its last statement has
        // no usable attributes (or a later identity split makes its current support unknown).
        // Facts used by the evaluator remain restricted to currently confirmed bindings above.
        const subjects = unique(allEntityStatements
          .map((statement) => `${statement.subjectEntityId ?? ''}\u0000${statement.objectId ?? ''}`)
          .map((key) => {
            const [subjectEntityId, objectId] = key.split('\u0000')
            return subjectEntityId === undefined || objectId === undefined ? undefined : { subjectEntityId, objectId, ...(this.#projectId === undefined ? {} : { projectId: this.#projectId }) }
          })
          .filter((subject): subject is { readonly subjectEntityId: string; readonly objectId: string } => subject !== undefined))
        const latestRules = new Map<string, PublishedRuleVersion>()
        for (const rule of scopedRuleVersions) {
          const key = ruleKey(rule)
          const existing = latestRules.get(key)
          if (existing === undefined || compareRevision(rule.version, existing.version) > 0) latestRules.set(key, rule)
        }
        const currentRules: PublishedExecutableRule[] = [...latestRules.values()]
        const packRules = this.#publishedRules
        if (packRules !== undefined) {
          if (!sameVersion(packRules.request.definitionRef, definitionRef) || packRules.request.projectId !== this.#projectId) throw new Error('published pack rule reader must use the exact source project/definition')
          let declarations
          try { declarations = await packRules.reader.read(scopeRef, packRules.request, ctx) } catch (error) {
            if (!(error instanceof IndustryAssetPublicationError)) throw error
            issues.push({ code: 'PUBLISHED_RULE_DECLARATION_UNAVAILABLE', message: error.message })
            return { facts: [], rules: [], entityBindings: [], definitionRef, historicalAsOfSupported: false, complete: false, issues }
          }
          const collisions = declarations.filter((rule) => currentRules.some((extracted) => ruleKey(extracted) === ruleKey(rule) || extracted.ruleVersionId === rule.ruleVersionId))
          if (collisions.length > 0) {
            issues.push({ code: 'PUBLISHED_RULE_ORIGIN_AMBIGUOUS', message: 'extracted and published-pack rules collide; an exact origin must be selected' })
            return { facts: [], rules: [], entityBindings: [], definitionRef, historicalAsOfSupported: false, complete: false, issues }
          }
          currentRules.push(...declarations)
        }
        const relationProjection = definition === undefined ? { facts: [], issues: [] } : projectPublishedRelationFacts(scopedStatements, { definition, bindings: identityBindings.bindings })
        issues.push(...relationProjection.issues)
        const facts = [...projection.facts, ...relationProjection.facts]
        const compiled = compilePublishedRuleInstances(currentRules, facts, {
          scopeRef,
          definitionRef,
          ...(this.#projectId === undefined ? {} : { projectId: this.#projectId }),
          ...(definition === undefined ? {} : { definition }),
          subjects,
          completeRangeAttributeIds: this.#completeRangeAttributeIds,
        })
        // This dependency-only map intentionally includes the latest published child aliases
        // even when current identity verification excluded those facts from computation. It
        // lets a later identity split/review or parent-statement revision invalidate old rules.
        const sourceStatementById = new Map(allEntityStatements.map((statement) => [statement.statementId, statement]))
        const publishedEntityByCandidate = new Map(allEntityStatements.map((statement) => [statement.sourceCandidateId, statement]))
        const relationEndpointBindings: DependencyEntityBinding[] = scopedStatements.filter((statement) => statement.kind === 'relation').flatMap((statement) =>
          [statement.value['from'], statement.value['to']].flatMap((endpoint) => {
            if (typeof endpoint !== 'object' || endpoint === null || !('candidateId' in endpoint) || typeof endpoint.candidateId !== 'string') return []
            const entity = publishedEntityByCandidate.get(endpoint.candidateId)
            return entity === undefined ? [] : [{ entityId: entity.subjectEntityId, logicalAssertionId: statement.statementId, sourceStatementId: statement.statementId, sourceCandidateId: endpoint.candidateId, predicate: statement.predicate }]
          }))
        const entityBindings: DependencyEntityBinding[] = [
          ...relationEndpointBindings,
          ...allEntityStatements.map((statement) => ({
            entityId: statement.subjectEntityId,
            logicalAssertionId: statement.statementId,
            sourceStatementId: statement.statementId,
            sourceCandidateId: statement.sourceCandidateId,
            predicate: statement.predicate,
          })),
          ...dependencyProjection.facts.map((fact) => {
            const statement = fact.sourceStatementId === undefined ? undefined : sourceStatementById.get(fact.sourceStatementId)
            return {
              entityId: fact.subject,
              logicalAssertionId: fact.logicalAssertionId,
              ...(fact.sourceStatementId === undefined ? {} : { sourceStatementId: fact.sourceStatementId }),
              ...(statement === undefined ? {} : { sourceCandidateId: statement.sourceCandidateId }),
              predicate: fact.predicate,
            }
          }),
        ]
        const rulesByVersion = new Map(currentRules.map((rule) => [rule.ruleVersionId, rule]))
        const computationRules: SupportRule[] = compiled.instances.flatMap((instance): SupportRule[] => {
          const published = rulesByVersion.get(instance.ruleVersionId)
          if (published === undefined || published.conclusion === undefined) return [instance.supportRule]
          if (!hasValidStoredConclusion(published) || !compiled.dependencyRules.some((rule) => rule.publishedInstance?.ruleVersionId === instance.ruleVersionId)) {
            issues.push({
              code: 'PUBLISHED_RULE_CONCLUSION_INVALID',
              message: `published rule ${published.ruleId} has a malformed business conclusion; only applicability is retained`,
            })
            return [instance.supportRule]
          }
          const binding = published.conclusion
          const consequenceRule = {
            ...instance.supportRule,
            ruleId: `${instance.instanceKey}:consequence`,
            ...(instance.supportRule.publishedInstance === undefined
              ? {}
              : { publishedInstance: { ...instance.supportRule.publishedInstance, emitApplicabilityArtifact: false } }),
            conclusion: {
              propositionKey: businessPropositionKey(scopeRef, definitionRef, instance.subjectEntityId, instance.objectId, binding.predicate, this.#projectId),
              predicate: binding.predicate,
              value: binding.value,
            },
          }
          return [instance.supportRule, consequenceRule]
        })
        return {
          facts,
          rules: [...computationRules, ...compiled.dependencyRules],
          entityBindings,
          identityBindings: [...identityBindings.bindings],
          definitionRef,
          historicalAsOfSupported: false,
          complete: relationProjection.issues.length === 0 && identityBindings.complete && unconfirmedIdentityCount === 0 && dependencyProjection.issues.length === 0 &&
            !issues.some((issue) => issue.code === 'PUBLISHED_RULE_CONCLUSION_INVALID') &&
            !issues.some((issue) => issue.code === 'PUBLICATION_NOT_FOUND'),
          ruleIssues: compiled.issues,
          attributeIssues: projection.issues,
          issues,
        }
      },
    )
    return { ...snapshot.value, readRevision: snapshot.readRevision }
  }

  async #readIdentityBindings(
    scopeRef: ScopeRef,
    statements: readonly PublishedStatement[],
    ctx: ToolContext,
  ): Promise<{
    readonly bindings: NonNullable<PublishedSemanticData['identityBindings']>
    readonly complete: boolean
    readonly issue?: NonNullable<PublishedSemanticData['issues']>[number]
  }> {
    const candidateIds = unique(statements.flatMap((statement) => {
      if (statement.kind === 'entity') return [statement.sourceCandidateId]
      return [statement.value['from'], statement.value['to']].flatMap((endpoint) => {
        if (typeof endpoint !== 'object' || endpoint === null || !('candidateId' in endpoint) || typeof endpoint.candidateId !== 'string') return []
        return [endpoint.candidateId]
      })
    }))
    if (candidateIds.length === 0) return { bindings: [], complete: true }
    const identity = this.#identity
    if (identity === undefined) {
      return {
        bindings: [],
        complete: false,
        issue: { code: 'IDENTITY_STORE_NOT_CONFIGURED', message: 'published attributes require an identity read provider' },
      }
    }
    const pages = await mapBounded(
      Array.from({ length: Math.ceil(candidateIds.length / IDENTITY_BATCH_SIZE) }, (_, index) => index),
      IDENTITY_READ_CONCURRENCY,
      async (page) => identity.readPublishedBindings(
        scopeRef,
        candidateIds.slice(page * IDENTITY_BATCH_SIZE, (page + 1) * IDENTITY_BATCH_SIZE),
        ctx,
      ),
    )
    const available = pages.filter((page): page is IdentityPublishedBindingSnapshot => page !== undefined)
    const revisions = unique(available.map((page) => page.readRevision))
    const complete = available.length === pages.length && available.every((page) => page.complete) && revisions.length <= 1
    const bindings = available.flatMap((page) => page.bindings)
    return {
      bindings,
      complete,
      ...(complete ? {} : { issue: { code: 'IDENTITY_BINDING_READ_INCOMPLETE', message: 'identity binding pages were incomplete or changed revision during the snapshot' } }),
    }
  }
}
