import { RESULT_HISTORY_SCHEMA_VERSION, isToolContext } from '@ontology/contracts'
import type {
  AnswerRevisionRecord,
  PublishedAnswer,
  ResourceRef,
  ResultHistoryPort,
  ResultHistoryView,
  ResultRevisionSummary,
  RunStore,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'

/**
 * Result revision history (SPEC v0.3a execution-evidence §EX-8, asset-data-ui §9.2,
 * issue V03-041 / #214, A.US-014.AC-01 / A.FR-21).
 *
 * Published answers are immutable and one-per-run. A new input/definition/mapping/rule/data
 * revision is a new project revision, hence a new run and a new answer; the older answer keeps
 * the body/table/evidence hashes it was verified with. This service exposes that lineage
 * newest-first for the project the run is bound to, and labels each entry `fixed_version`
 * (the exact version this run published) or `history` (an older revision read back).
 *
 * It never recomputes: a readback of an older revision is a history read, and a fixed-version
 * recompute is a new run. When a run has no project execution binding the history is that one
 * run's own immutable version, explicitly labelled, rather than a fabricated lineage.
 */

/** The narrow binding reader the history needs (satisfied by `RunExecutionBindingStore`). */
export interface ResultHistoryBindingPort {
  getBindingByRun(
    scopeRef: ScopeRef,
    runId: string,
    ctx: ToolContext,
  ): Promise<{ readonly binding: { readonly request: { readonly projectRevisionRef: { readonly projectId: string; readonly revision: string } } } } | undefined>
}

/** The narrow run reader the history needs (satisfied by `RunStore`). */
export type ResultHistoryRunPort = Pick<RunStore, 'getRun'>

export interface ResultHistoryDependencies {
  readonly answers: { findByRun(runId: string, ctx: ToolContext): Promise<PublishedAnswer | undefined> }
  readonly bindings: ResultHistoryBindingPort
  readonly history: ResultHistoryPort
}

export type ResultHistoryErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'RESULT_NOT_AVAILABLE'

const ERROR_HTTP_STATUS: Readonly<Record<ResultHistoryErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  RUN_NOT_FOUND: 404,
  RESULT_NOT_AVAILABLE: 404,
}

export class ResultHistoryError extends Error {
  readonly code: ResultHistoryErrorCode
  readonly httpStatus: number

  constructor(code: ResultHistoryErrorCode, message: string) {
    super(message)
    this.name = 'ResultHistoryError'
    this.code = code
    this.httpStatus = ERROR_HTTP_STATUS[code]
  }
}

function scopeRefOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ResultHistoryError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ResultHistoryError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function toSummary(
  answer: PublishedAnswer,
  revisionIndex: number,
  readKind: ResultRevisionSummary['readKind'],
): ResultRevisionSummary {
  const v3 = answer.v3Body
  const resultManifestRef: ResourceRef | undefined = v3?.resultManifestRef
  return {
    answerId: answer.answerId,
    runId: answer.runId,
    revisionIndex,
    contentHash: answer.contentHash,
    evidenceManifestHash: answer.evidenceManifestHash,
    scenarioManifestHash: answer.scenarioManifestHash,
    publicationKind: answer.publicationKind,
    publishedAt: answer.publishedAt,
    ...(resultManifestRef === undefined ? {} : { resultManifestRef }),
    ...(v3 === undefined ? {} : { resultManifestDigest: v3.resultManifestDigest }),
    readKind,
    label:
      readKind === 'fixed_version'
        ? '固定版本回读：本次运行发布的精确已核验版本'
        : '历史回读：旧修订的归档结果（不是重算）',
  }
}

/** Newest first; ties broken by run id so the order is deterministic. */
function byPublishedAtDescending(left: PublishedAnswer, right: PublishedAnswer): number {
  const delta = Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
  return delta !== 0 ? delta : left.runId.localeCompare(right.runId)
}

export class ResultHistoryService {
  readonly #answers: ResultHistoryDependencies['answers']
  readonly #bindings: ResultHistoryBindingPort
  readonly #history: ResultHistoryPort

  constructor(dependencies: ResultHistoryDependencies) {
    this.#answers = dependencies.answers
    this.#bindings = dependencies.bindings
    this.#history = dependencies.history
  }

  async getHistory(runId: string, ctx: ToolContext): Promise<ResultHistoryView> {
    const scopeRef = scopeRefOf(ctx)
    const current = await this.#answers.findByRun(runId, ctx)
    if (current === undefined) {
      throw new ResultHistoryError(
        'RESULT_NOT_AVAILABLE',
        `run ${runId} has no published answer visible in this scope`,
      )
    }
    const binding = await this.#bindings.getBindingByRun(scopeRef, runId, ctx)
    const projectRevisionRef = binding?.binding.request.projectRevisionRef

    if (projectRevisionRef === undefined) {
      return {
        schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
        logicalKey: runId,
        currentAnswerId: current.answerId,
        entries: [toSummary(current, 1, 'fixed_version')],
      }
    }

    const records = await this.#history.listByProject(scopeRef, projectRevisionRef.projectId, ctx)
    const byRun = new Map<string, PublishedAnswer>()
    for (const record of records) byRun.set(record.answer.runId, record.answer)
    // The current answer is always part of its own history, even if the store listing lags.
    byRun.set(current.runId, current)
    const ordered = [...byRun.values()].sort(byPublishedAtDescending)
    return {
      schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
      logicalKey: projectRevisionRef.projectId,
      projectId: projectRevisionRef.projectId,
      projectRevision: projectRevisionRef.revision,
      currentAnswerId: current.answerId,
      entries: ordered.map((answer, index) =>
        toSummary(answer, index + 1, answer.runId === runId ? 'fixed_version' : 'history'),
      ),
    }
  }
}

export type { AnswerRevisionRecord }
