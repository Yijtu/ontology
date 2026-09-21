import { randomUUID } from 'node:crypto'
import type {
  BudgetPort,
  BudgetRemaining,
  BudgetReservationRef,
  BudgetReservationRequest,
  JobStageCounts,
  OutboxMessageRecord,
  PipelineStage,
  RunnableJobStage,
  ToolContext,
  ToolUsage,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type {
  JobStageHandler,
  JobStageHandlerRegistry,
  JobStageOutcome,
  OutboxConsumer,
} from '@ontology/application'
import { JobStageFailure } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'
import { SCOPE_A, SCOPE_B } from './profile-resolver-fixtures'

export { SCOPE_A, SCOPE_B }

/** Deterministic, manually advanced clock for lease-expiry tests. */
export class ManualClock {
  #current: number

  constructor(startMs = Date.UTC(2026, 8, 21, 0, 0, 0)) {
    this.#current = startMs
  }

  now = (): string => new Date(this.#current).toISOString()

  advance(ms: number): void {
    this.#current += ms
  }

  get currentMs(): number {
    return this.#current
  }
}

export const EDITOR_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'job-editor-a')
export const VIEWER_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['scoped-reader'], 'job-viewer-a')
export const STRANGER_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'job-stranger-a')
export const EDITOR_B: ToolContext = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['data-editor'], 'job-editor-b')

export const PUBLICATION_VERSION: VersionRef = {
  id: 'document-version-1',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}

export interface PipelineOptions {
  /** When true, `validated` publishes and moves to `published`; otherwise it stops at `awaiting_review`. */
  readonly publish?: boolean
  /** Fail when the pipeline reaches this stage. */
  readonly failAt?: RunnableJobStage
  /** Reserve and settle one background model call per stage. */
  readonly useQuota?: boolean
  readonly onStage?: (stage: RunnableJobStage, jobId: Uuid) => void
}

const NEXT: Readonly<Record<RunnableJobStage, PipelineStage>> = {
  received: 'parsed',
  parsed: 'extracted',
  extracted: 'validated',
  validated: 'awaiting_review',
}

function countFor(previous: JobStageCounts): JobStageCounts {
  return {
    total: previous.total + 1,
    processed: previous.processed + 1,
    failed: previous.failed,
    skipped: previous.skipped,
  }
}

/**
 * Controlled pipeline handlers. They stand in for the parser/extractor that later nodes own,
 * so the stage/checkpoint contract is proven without implementing document parsing.
 */
export function pipelineHandlers(options: PipelineOptions = {}): JobStageHandlerRegistry {
  const handlers = new Map<RunnableJobStage, JobStageHandler>()
  const stages: readonly RunnableJobStage[] = ['received', 'parsed', 'extracted', 'validated']
  for (const stage of stages) {
    handlers.set(stage, {
      stage,
      run: async (context): Promise<JobStageOutcome> => {
        options.onStage?.(stage, context.job.jobId)
        if (options.useQuota === true) {
          const reservation = await context.quota.reserve(
            context.job.jobId,
            { budgetClass: 'background_job', modelCalls: 1 },
            context.ctx,
          )
          await context.quota.settle(
            reservation,
            { modelCalls: 1, modelTokens: 10 },
            context.ctx,
          )
        }
        if (options.failAt === stage) {
          throw new JobStageFailure('SOURCE_UNAVAILABLE', 'the controlled source was unavailable', true)
        }
        const nextStage =
          stage === 'validated' && options.publish === true ? 'published' : NEXT[stage]
        const counts = countFor(context.job.counts)
        if (nextStage === 'published') {
          return {
            nextStage,
            counts,
            publication: {
              publicationKey: `document-version:${context.job.jobId}`,
              versionRef: PUBLICATION_VERSION,
              outboxTopic: 'semantic.publication.committed',
              outboxPayload: { jobId: context.job.jobId, versionRef: PUBLICATION_VERSION },
            },
          }
        }
        return { nextStage, counts }
      },
    })
  }
  return {
    get: (stage) => (stage in NEXT ? handlers.get(stage as RunnableJobStage) : undefined),
  }
}

/** Idempotent consumer: a duplicate delivery of the same key is recorded only once. */
export class RecordingOutboxConsumer implements OutboxConsumer {
  readonly seenKeys: string[] = []
  readonly #seen = new Set<string>()

  async consume(message: OutboxMessageRecord): Promise<void> {
    if (this.#seen.has(message.idempotencyKey)) return
    this.#seen.add(message.idempotencyKey)
    this.seenKeys.push(message.idempotencyKey)
  }
}

/**
 * Spy on the online run budget. The background quota must never touch it, so a job run leaves
 * every counter at zero.
 */
export class OnlineBudgetSpy implements BudgetPort {
  reserveCalls = 0
  settleCalls = 0

  async reserve(
    runId: string,
    _request: BudgetReservationRequest,
    _ctx: ToolContext,
  ): Promise<BudgetReservationRef> {
    void _request
    void _ctx
    this.reserveCalls += 1
    return {
      reservationId: randomUUID(),
      runId,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  }

  async settle(
    _reservation: BudgetReservationRef,
    _usage: ToolUsage,
    _ctx: ToolContext,
  ): Promise<void> {
    void _reservation
    void _usage
    void _ctx
    this.settleCalls += 1
  }

  async remaining(_runId: string, _ctx: ToolContext): Promise<BudgetRemaining> {
    void _runId
    void _ctx
    return {
      deadline: new Date(Date.now() + 60_000).toISOString(),
      toolCallsRemaining: 8,
      repairAttemptsRemaining: 2,
      parallelToolLimit: 2,
    }
  }
}

export interface NewJobInput {
  readonly kind?: 'ingestion' | 'simulation'
  readonly sourceRef?: string
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly pipelineVersion?: string
  readonly idempotencyKey?: string
}

export function newJobInput(overrides: NewJobInput = {}) {
  return {
    jobId: randomUUID(),
    kind: overrides.kind ?? ('ingestion' as const),
    sourceRef: overrides.sourceRef ?? 'source-1',
    documentRef: overrides.documentRef ?? `document-${randomUUID()}`,
    ...(overrides.datasetRef === undefined ? {} : { datasetRef: overrides.datasetRef }),
    pipelineVersion: overrides.pipelineVersion ?? '1.0.0',
    idempotencyKey: overrides.idempotencyKey ?? `idem-${randomUUID()}`,
  }
}
