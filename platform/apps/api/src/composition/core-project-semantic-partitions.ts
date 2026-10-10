import { WorkflowControllerError, canonicalJson } from '@ontology/application'
import { assertProjectFactInputShape, isRecord } from '@ontology/contracts'
import type { MaterializationPublishedSource, PublishedSemanticData } from '@ontology/semantic-engine'
import type { ProjectFactSourcePin, ProjectRevision, ScopeRef, ToolContext } from '@ontology/contracts'
import type { CoreSemanticTaskResolver, CoreSemanticTaskResolverOptions } from './core-semantic-task-resolver'

function sameProjectRevision(left: ProjectRevision['ref'], right: ProjectRevision['ref']): boolean {
  return left.projectId === right.projectId && left.revision === right.revision && left.digest === right.digest
}

function sameDefinition(left: ProjectRevision['definitionRef'], right: ProjectRevision['definitionRef']): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

async function hasExactHistoricalProjectPartition(input: {
  readonly part: PublishedSemanticData
  readonly projectId: string
  readonly active: ProjectRevision
  readonly scope: ScopeRef
  readonly ctx: ToolContext
  readonly projects: CoreSemanticTaskResolver['options']['projects']
}): Promise<boolean> {
  const oldDefinition = input.part.premiseInput?.definition
  if (oldDefinition === undefined || sameDefinition(oldDefinition.ref, input.active.definitionRef) ||
    input.part.definitionRef === undefined || !sameDefinition(input.part.definitionRef, oldDefinition.ref)) return false
  const statements = [...input.part.premiseInput?.attributeStatements ?? [], ...input.part.premiseInput?.relationStatements ?? []]
  if (statements.length === 0 || statements.length > 10_000) return false
  const projectFacts = input.part.facts.filter((fact) => fact.projectId === input.projectId)
  if (projectFacts.length === 0 || projectFacts.length > 10_000) return false
  const statementsById = new Map<string, typeof statements>()
  for (const statement of statements) {
    const grouped = statementsById.get(statement.statementId) ?? []
    statementsById.set(statement.statementId, [...grouped, statement])
  }
  const pins = new Map<string, Map<string, ProjectFactSourcePin>>()
  for (const fact of projectFacts) {
    if (fact.sourceStatementId === undefined || fact.sourceStatementId.length === 0) return false
    const matching = statementsById.get(fact.sourceStatementId) ?? []
    if (matching.length !== 1) return false
    const [statement] = matching
    if (statement === undefined) return false
    const provenance = statement.value['provenance']
    if (!isRecord(provenance)) return false
    try { assertProjectFactInputShape(provenance) } catch { return false }
    const related = provenance.sources.filter((source) => source.projectRevisionRef.projectId === input.projectId)
    if (related.length !== provenance.sources.length || related.length === 0) return false
    for (const source of related) {
      if (!sameDefinition(source.definitionRef, oldDefinition.ref)) return false
      const key = canonicalJson(source.projectRevisionRef)
      const relatedPins = pins.get(key) ?? new Map<string, ProjectFactSourcePin>()
      relatedPins.set(canonicalJson(source), source)
      pins.set(key, relatedPins)
    }
  }
  // Bound exact historical revision reads independently of the partition count.
  if (pins.size === 0 || pins.size > 32) return false
  const project = await input.projects.getProject(input.scope, input.projectId, input.ctx)
  if (project === undefined || project.state === 'archived') return false
  const activeRevision = project.activeRevision ?? project.headRevision
  if (activeRevision !== input.active.ref.revision) return false
  for (const [revisionKey, sourcePins] of pins) {
    const sources = [...sourcePins.values()]
    const revisionRef = JSON.parse(revisionKey) as ProjectRevision['ref']
    const revision = await input.projects.getRevision(input.scope, input.projectId, revisionRef.revision, input.ctx)
    if (revision === undefined || !sameProjectRevision(revision.ref, revisionRef) || revision.executionPurpose === 'synthetic_validation' || !sameDefinition(revision.definitionRef, oldDefinition.ref) ||
      sources.some((source) => !revision.mappingRefs.some((mapping) => canonicalJson(mapping) === canonicalJson(source.mappingRef)))) return false
    const revisionNumber = BigInt(revision.ref.revision)
    const activeNumber = BigInt(input.active.ref.revision)
    const isActivatedHistory = revisionNumber < activeNumber
    const isCurrentActive = revision.ref.revision === activeRevision && sameProjectRevision(revision.ref, input.active.ref)
    const isStagedHead = project.headRevision !== activeRevision && revision.ref.revision === project.headRevision &&
      sameProjectRevision(revision.ref, { projectId: input.projectId, revision: project.headRevision, digest: revision.ref.digest })
    if (!isActivatedHistory && !isCurrentActive && !isStagedHead) return false
  }
  return true
}

/** Preserve each existing definition partition and append actual authorized project partitions. */
export class CoreProjectSemanticPartitions implements MaterializationPublishedSource {
  constructor(readonly base: MaterializationPublishedSource, readonly selectors: { readonly options: Pick<CoreSemanticTaskResolverOptions, 'projects' | 'source' | 'definition'> },
    readonly inventory?: (scope: ScopeRef, ctx: ToolContext) => Promise<readonly ProjectRevision[]>) {}
  async load(scope: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const original = await this.base.load(scope, ctx)
    const parts = [...original.partitions ?? [original]]
    const keys = new Set<string>()
    const activeRevisions = new Map<string, ProjectRevision>()
    const added: PublishedSemanticData[] = []
    for (const revision of await this.inventory?.(scope, ctx) ?? []) {
      if (revision.executionPurpose === 'synthetic_validation') continue
      const key = `${revision.ref.projectId}:${canonicalJson(revision.definitionRef)}`
      activeRevisions.set(revision.ref.projectId, revision)
      if (keys.has(key)) continue
      keys.add(key)
      if (keys.size > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the host project materialization inventory exceeds its finite 32-partition bound')
      const definition = await this.selectors.options.definition(scope, revision.definitionRef, ctx)
      if (definition === undefined) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'an actual project has no exact stored definition partition')
      added.push(await this.selectors.options.source(revision, definition).load(scope, ctx))
    }
    for (const part of parts) {
      const definition = part.premiseInput?.definition
      const ids = [...new Set(part.facts.flatMap((fact) => fact.projectId === undefined ? [] : [fact.projectId]))]
      for (const id of ids) {
        const key = `${id}:${definition === undefined ? '' : canonicalJson(definition.ref)}`
        if (keys.has(key)) continue
        const active = activeRevisions.get(id)
        if (active !== undefined && definition !== undefined && !sameDefinition(active.definitionRef, definition.ref)) {
          if (!await hasExactHistoricalProjectPartition({ part, projectId: id, active, scope, ctx, projects: this.selectors.options.projects })) {
            throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'a historical project partition has no exact authorized stored revision provenance')
          }
          keys.add(key)
          if (keys.size > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the host project materialization inventory exceeds its finite 32-partition bound')
          continue
        }
        keys.add(key)
        if (keys.size > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the host project materialization inventory exceeds its finite 32-partition bound')
        const project = await this.selectors.options.projects.getProject(scope, id, ctx)
        const revision = project === undefined ? undefined : await this.selectors.options.projects.getRevision(scope, id, project.activeRevision ?? project.headRevision, ctx)
        if (revision?.executionPurpose === 'synthetic_validation') throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'a private competency fact entered the normal business publication source')
        if (project === undefined || project.state === 'archived' || revision === undefined || definition === undefined || revision.definitionRef.digest !== definition.ref.digest || revision.definitionRef.id !== definition.ref.id || revision.definitionRef.version !== definition.ref.version) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'an official project fact has no exact authorized active definition partition')
        added.push(await this.selectors.options.source(revision, definition).load(scope, ctx))
      }
    }
    const all = [...parts, ...added]
    const point = original.readRevision
    const stable = point !== undefined && all.every((part) => part.readRevision?.semantic === point.semantic && part.readRevision.identity === point.identity)
    return { ...original, partitions: all, facts: all.flatMap((part) => part.facts), rules: all.flatMap((part) => part.rules), entityBindings: all.flatMap((part) => part.entityBindings),
      complete: original.complete === true && stable && added.every((part) => part.complete === true),
      issues: [...original.issues ?? [], ...added.flatMap((part) => part.issues ?? []), ...stable ? [] : [{ code: 'READ_REVISION_CHANGED', message: 'project partitions changed during the official source read' }]],
    }
  }
}
