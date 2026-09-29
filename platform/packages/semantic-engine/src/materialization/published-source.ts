import type {
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { IdentityDecisionStore, IdentityPublishedBindingSnapshot } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import {
  compilePublishedRuleInstances,
  projectPublishedAttributeFacts,
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
  /** The run/profile pin. A multi-schema scope must provide an exact definition version. */
  readonly definitionRef?: VersionRef
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

function ruleKey(rule: PublishedRuleVersion): string {
  return `${rule.ruleId}\u0000${rule.objectId}`
}

function businessPropositionKey(scopeRef: ScopeRef, definitionRef: VersionRef, subjectEntityId: string, predicate: string): string {
  return `business-conclusion:${sha256DigestOf({ scopeRef, definitionRef, subjectEntityId, predicate })}`
}

function hasValidStoredConclusion(rule: PublishedRuleVersion): boolean {
  const binding = rule.conclusion
  if (binding === undefined) return true
  if (typeof binding.predicate !== 'string' || binding.predicate.length === 0) return false
  if (typeof binding.value === 'string' || typeof binding.value === 'boolean') return true
  return typeof binding.value === 'object' && binding.value !== null &&
    typeof binding.value.amount === 'string' && typeof binding.value.unit === 'string'
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
  readonly #pageLimits: PublishedPageLimits
  readonly #completeRangeAttributeIds: readonly string[]

  constructor(readView: PublishedSemanticReadView, options: PublishedSemanticSourceOptions = {}) {
    this.#readView = readView
    this.#identity = options.identity
    this.#definitionRef = options.definitionRef
    this.#pageLimits = {
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS,
    }
    this.#completeRangeAttributeIds = options.completeRangeAttributeIds ?? []
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
        const scopedStatements = statements.filter(inDefinition)
        const scopedRuleVersions = ruleVersions.filter(inDefinition)
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
        const projection = projectPublishedAttributeFacts(validEntityStatements, { schemaRef: definitionRef })
        const dependencyProjection = projectPublishedAttributeFacts(allEntityStatements, { schemaRef: definitionRef })
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
            return subjectEntityId === undefined || objectId === undefined ? undefined : { subjectEntityId, objectId }
          })
          .filter((subject): subject is { readonly subjectEntityId: string; readonly objectId: string } => subject !== undefined))
        const latestRules = new Map<string, PublishedRuleVersion>()
        for (const rule of scopedRuleVersions) {
          const key = ruleKey(rule)
          const existing = latestRules.get(key)
          if (existing === undefined || compareRevision(rule.version, existing.version) > 0) latestRules.set(key, rule)
        }
        const currentRules = [...latestRules.values()]
        const compiled = compilePublishedRuleInstances(currentRules, projection.facts, {
          scopeRef,
          definitionRef,
          subjects,
          completeRangeAttributeIds: this.#completeRangeAttributeIds,
        })
        // This dependency-only map intentionally includes the latest published child aliases
        // even when current identity verification excluded those facts from computation. It
        // lets a later identity split/review or parent-statement revision invalidate old rules.
        const sourceStatementById = new Map(allEntityStatements.map((statement) => [statement.statementId, statement]))
        const entityBindings: DependencyEntityBinding[] = [
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
          if (!hasValidStoredConclusion(published)) {
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
              propositionKey: businessPropositionKey(scopeRef, definitionRef, instance.subjectEntityId, binding.predicate),
              predicate: binding.predicate,
              value: binding.value,
            },
          }
          return [instance.supportRule, consequenceRule]
        })
        return {
          facts: [...projection.facts],
          rules: computationRules,
          entityBindings,
          identityBindings: [...identityBindings.bindings],
          definitionRef,
          historicalAsOfSupported: false,
          complete: identityBindings.complete && unconfirmedIdentityCount === 0 && dependencyProjection.issues.length === 0 &&
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
    const candidateIds = unique(statements.filter((statement) => statement.kind === 'entity').map((statement) => statement.sourceCandidateId))
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
