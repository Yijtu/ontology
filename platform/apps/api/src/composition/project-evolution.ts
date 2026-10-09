import { ProjectDataMaterializationService, ProjectEvolutionService } from '@ontology/application'
import type { ProjectEvolutionDependencies } from '@ontology/application'
import type { ProjectDatasetQueryPort, ProjectDatasetWriterPort } from '@ontology/contracts'
export type ProjectEvolutionWorkflowOptions = Omit<ProjectEvolutionDependencies, 'dataset'> & {
    readonly dataset: {
        readonly writer: ProjectDatasetWriterPort
        readonly query: ProjectDatasetQueryPort
    }
}
/** Leaf factory; the deployment injects the same original/human/fact ports used by ordinary routes. */
export function createProjectEvolutionWorkflow(options: ProjectEvolutionWorkflowOptions) {
    const dataset: ProjectDataMaterializationService = new ProjectDataMaterializationService({
        projects: options.projects, publishedSource: options.publishedSource, readiness: options.readiness, schemaSource: options.schemas,
        writer: options.dataset.writer, query: options.dataset.query, evolution: {
            assertActiveRebuild: (scope, revision, ctx) => service.assertActiveRebuild(scope, revision, ctx), resolveActiveSnapshot: (scope, revision, objectId, ctx) => service.resolveActiveSnapshot(scope, revision, objectId, ctx)
        }
    })
    const service: ProjectEvolutionService = new ProjectEvolutionService({
        ...options, dataset
    })
    return {
        service, dataset
    }
}
