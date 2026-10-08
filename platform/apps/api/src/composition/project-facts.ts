import { ProjectFactMaterializationService } from '@ontology/application'
import type { ProjectFactMaterializationDependencies } from '@ontology/application'
import { SemanticPublicationService } from '@ontology/semantic-engine'
import type { SemanticPublicationServiceDependencies } from '@ontology/semantic-engine'
import type { InstanceReviewStore } from '@ontology/contracts'

export interface ProjectFactWorkflowOptions {
  readonly materialization: ProjectFactMaterializationDependencies
  readonly publication: Omit<SemanticPublicationServiceDependencies, 'candidates' | 'schemaSource' | 'instanceRecords'>
  readonly instanceRecords: Pick<InstanceReviewStore, 'getRecord'>
}

/** Normal host seam: shared stored candidates, schema and human instance confirmations. */
export function createProjectFactWorkflow(options: ProjectFactWorkflowOptions) {
  return {
    materialization: new ProjectFactMaterializationService(options.materialization),
    publication: new SemanticPublicationService({
      ...options.publication, candidates: options.materialization.candidates,
      schemaSource: options.materialization.schemaSource, instanceRecords: options.instanceRecords,
      projects: options.materialization.projects,
    }),
  }
}
