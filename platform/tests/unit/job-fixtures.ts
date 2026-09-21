import { randomUUID } from 'node:crypto'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import type {
  BudgetLedgerPort,
  JobStageCounts,
  OutboxMessageRecord,
  PipelineStage,
  RunnableJobStage,
  ToolContext,
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
import { RecordingControlRepository, toolContext } from './component-registry-fixtures'
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
          const outcome = await context.budget.reserve(
            {
              ledgerId: context.ledgerId,
              idempotencyKey: `job-stage:${context.job.jobId}:${context.attempt.attemptId}:${stage}`,
              modelTokens: 10,
            },
            context.ctx,
          )
          if (outcome.granted && outcome.reservation !== undefined) {
            await context.budget.settle(
              {
                ledgerId: context.ledgerId,
                reservationId: outcome.reservation.reservationId,
                status: 'completed',
                usage: { durationMs: 1, modelTokens: 10 },
                // A completed settlement requires persisted evidence (SPEC §8); the controlled
                // handler supplies a synthetic reference instead of a real artifact.
                evidenceRefs: [
                  {
                    id: randomUUID(),
                    version: '1.0.0',
                    digest: `sha256:${'e'.repeat(64)}`,
                    kind: 'evidence',
                  },
                ],
              },
              context.ctx,
            )
          }
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
 * The shared budget ledger, used by both online runs and background jobs. Jobs draw from a
 * `background` ledger; an online run has its own `run` ledger, so the two never share quota.
 */
export interface BudgetHarness {
  readonly budget: BudgetLedgerPort
  readonly store: InMemoryBudgetLedgerStore
  readonly service: BudgetService
}

export function createBudgetHarness(): BudgetHarness {
  const store = new InMemoryBudgetLedgerStore()
  const service = new BudgetService({
    store,
    control: new RecordingControlRepository(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
  return { budget: service, store, service }
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
