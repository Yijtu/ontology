import { WorkflowControllerError } from '@ontology/application'
import type { MaterializationPublishedSource, PublishedSemanticData } from '@ontology/semantic-engine'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import type { CoreSemanticTaskResolver } from './core-semantic-task-resolver'

/** Preserve each existing definition partition and append actual authorized project partitions. */
export class CoreProjectSemanticPartitions implements MaterializationPublishedSource {
  constructor(readonly base: MaterializationPublishedSource, readonly selectors: CoreSemanticTaskResolver) {}
  async load(scope: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const original = await this.base.load(scope, ctx)
    const parts = [...original.partitions ?? [original]]
    const keys = new Set<string>()
    const added: PublishedSemanticData[] = []
    for (const part of parts) {
      const definition = part.premiseInput?.definition
      const ids = [...new Set(part.facts.flatMap((fact) => fact.projectId === undefined ? [] : [fact.projectId]))]
      for (const id of ids) {
        const key = `${id}:${definition?.ref.digest ?? ''}`
        if (keys.has(key)) continue
        keys.add(key)
        if (keys.size > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the host project materialization inventory exceeds its finite 32-partition bound')
        const project = await this.selectors.options.projects.getProject(scope, id, ctx)
        const revision = project === undefined ? undefined : await this.selectors.options.projects.getRevision(scope, id, project.activeRevision ?? project.headRevision, ctx)
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
