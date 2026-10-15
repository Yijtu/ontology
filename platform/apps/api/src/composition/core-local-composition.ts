import { assembleDeployment } from './core-assembly-deployment'
import { assembleInfrastructure } from './core-assembly-infrastructure'
import { assembleQueryPipeline } from './core-assembly-query'
import { assembleRuntimePipeline } from './core-assembly-runtime'
import { CoreCapabilityError } from './core-errors'
import { createDuckDbSnapshot } from './core-duckdb-snapshot'
import { createCoreStructuredImportWorkflow } from './core-structured-import-service'
import type { CoreApiDependencies } from '../core-main'
import type { CoreComputeRegistration } from './core-compute-registration'
import type { PostgresProjectDatasetConfig } from '@ontology/adapter-data-postgres'
import type { ScopeRef } from '@ontology/contracts'
import type { LoadedCoreExamples } from './core-example-loader'

export { CoreCapabilityError } from './core-errors'
export { CORE_TYPED_RESULT_SCHEMA_REF } from './core-constants'
export { createDuckDbSnapshot }

export interface CoreLocalCompositionOptions {
  readonly databaseUrl: string
  readonly objectDirectory: string
  /** Explicit independent business database writer/query credentials; omitted uses rebuildable DuckDB. */
  readonly projectDataset?: PostgresProjectDatasetConfig
  /** Narrow active-snapshot guard; full evolution composition is owned by the deployment. */
  readonly projectEvolution?: import('@ontology/application').ProjectEvolutionService
  /** Narrow optional leaf; broad production mounting is owned by the deployment factory. */
  readonly projectStructuredImports?: typeof createCoreStructuredImportWorkflow
  readonly scopeRef: ScopeRef
  /** Optional synthetic example assembly; a zero-scenario kernel omits it. */
  readonly examples?: LoadedCoreExamples
  /** Registered-compute surface; defaults to the neutral synthetic example operation. */
  readonly compute?: CoreComputeRegistration
  readonly allowLocalOperator?: boolean
  readonly modelsEnabled?: boolean
  readonly jevEnabled?: boolean
  /** Server-side model configuration. The browser process never receives this object. */
  readonly modelEnvironment?: Readonly<Record<string, string | undefined>>
  /** The legacy local model-settings store the one-time catalogue migration reads. */
  readonly modelSettings?: import('./core-local-model-settings').CoreLocalModelSettings
  /** Enables the modelling research surface; web_search stays disabled when it is omitted. */
  readonly webSearch?: import('@ontology/contracts').WebSearchProvider
  /** Injectable host clock for deadline/recovery verification; production defaults to wall time. */
  readonly clock?: () => Date
  /** Test/host observer. The default logs no payload text. */
  readonly onWorkerError?: (error: unknown) => void
  readonly logger?: boolean
}

export interface CoreLocalComposition {
  readonly dependencies: CoreApiDependencies
  close(): Promise<void>
}

// `sourceRefsOf` now lives in ./core-component-registration.

export async function createCoreLocalComposition(options: CoreLocalCompositionOptions): Promise<CoreLocalComposition> {
  const cleanup: (() => Promise<void>)[] = []
  let state: Awaited<ReturnType<typeof assembleInfrastructure>> | undefined
  try {
    state = await assembleInfrastructure(options, cleanup)
    const { host } = state

    const query = await assembleQueryPipeline(state, options)
    const { duckDb } = query

    const runtime = await assembleRuntimePipeline(state, query, options)
    const { workflowDispatchWorker } = runtime

    const { dependencies } = await assembleDeployment(state, query, runtime, options)

    // Start recovery only after every normal source, input and evolution port is mounted.
    host.jobLoopAbort = new AbortController()
    if (host.jobLoop === undefined) throw new CoreCapabilityError('the Core job loop is not mounted')
    host.jobLoopPromise = host.jobLoop.start(host.jobLoopAbort.signal)
    host.dispatchAbort = new AbortController()
    host.dispatchWorkerPromise = workflowDispatchWorker.run(host.dispatchAbort.signal)
    return {
      dependencies,
      async close() {
        await host.dispatchAbort?.abort()
        host.jobLoopAbort?.abort()
        host.jobLoop?.stop()
        for (const runId of host.activeRunIds) host.controller?.abortActiveWork(runId, 'Core host is shutting down')
        await Promise.allSettled([
          ...(host.jobLoopPromise === undefined ? [] : [host.jobLoopPromise]),
          ...(host.dispatchWorkerPromise === undefined ? [] : [host.dispatchWorkerPromise]),
        ])
        duckDb.close()
        for (const close of cleanup) await close().catch(() => undefined)
      },
    }
  } catch (error) {
    state?.host.dispatchAbort?.abort()
    state?.host.jobLoop?.stop()
    for (const close of cleanup) await close().catch(() => undefined)
    throw error
  }
}
