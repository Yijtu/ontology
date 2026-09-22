import { useCallback, useEffect, useState } from 'react'
import type { PipelineStage, RunnableJobStage } from '@ontology/contracts'
import { ApiError, type WorkbenchClient } from '../api/client'
import type { JobView } from '../api/review'
import { StatePanel } from './StatePanel'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'

/**
 * The ingestion job panel. It renders the real stage, the per-stage counts and every attempt,
 * and it keeps the processed count and the published count visibly apart: a processed
 * candidate is not a published statement (SPEC D6, §4.1). A partial failure stays failed
 * until an explicit retry, which carries the `If-Match` revision the operator read.
 */

export interface JobProgressPanelProps {
  readonly client: WorkbenchClient
  /** Deep-linked job id (`?job=<id>`); when set the panel loads it on mount. */
  readonly initialJobId?: string
}

const PIPELINE_STAGES: readonly PipelineStage[] = [
  'received',
  'parsed',
  'extracted',
  'validated',
  'awaiting_review',
  'published',
]

const STAGE_LABEL: Readonly<Record<PipelineStage, string>> = {
  received: '已接收',
  parsed: '已解析',
  extracted: '已抽取',
  validated: '已校验',
  awaiting_review: '待审核',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
}

const RUNNABLE: readonly PipelineStage[] = ['received', 'parsed', 'extracted', 'validated']

function isRunnable(stage: PipelineStage | undefined): stage is RunnableJobStage {
  return stage !== undefined && (RUNNABLE as readonly PipelineStage[]).includes(stage)
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'the request could not be completed',
  }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError) {
    if (error.permissionDenied) return 'permission_denied'
    if (error.code === 'CAPABILITY_NOT_CONFIGURED') return 'not_configured'
  }
  return 'failure'
}

export function JobProgressPanel({ client, initialJobId }: JobProgressPanelProps) {
  const [jobId, setJobId] = useState(initialJobId ?? '')
  const [job, setJob] = useState<JobView | undefined>(undefined)
  const [phase, setPhase] = useState<WorkbenchPhase>(initialJobId === undefined ? 'empty' : 'loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [conflict, setConflict] = useState<WorkbenchError | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (id: string) => {
      if (id.length === 0) {
        setPhase('empty')
        setJob(undefined)
        return
      }
      setBusy(true)
      setConflict(undefined)
      try {
        const view = await client.getJob(id)
        setJob(view)
        setPhase('ready')
      } catch (caught) {
        setError(toError(caught))
        setPhase(phaseFor(caught))
      } finally {
        setBusy(false)
      }
    },
    [client],
  )

  useEffect(() => {
    if (initialJobId !== undefined) void load(initialJobId)
  }, [initialJobId, load])

  const retry = async () => {
    if (job === undefined || !isRunnable(job.failedStage)) return
    setBusy(true)
    setConflict(undefined)
    try {
      await client.retryJob(job.jobId, {
        failedStage: job.failedStage,
        expectedRevision: job.revision,
      })
      setNotice('已按阶段重试，生成同一逻辑任务的新尝试。')
      await load(job.jobId)
    } catch (caught) {
      if (caught instanceof ApiError && caught.conflict) {
        setConflict(toError(caught))
        setBusy(false)
        return
      }
      setError(toError(caught))
      setPhase(phaseFor(caught))
      setBusy(false)
    }
  }

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    void load(jobId.trim())
  }

  const failed = job !== undefined && (job.counts.failed > 0 || job.stage === 'failed')
  const published = job?.publication !== undefined

  return (
    <section className="jobs" data-testid="job-panel" data-phase={phase}>
      <header className="panel__header">
        <h2>导入任务</h2>
        <p className="panel__hint">
          阶段、部分失败与重试真实可见。「已处理」是阶段处理的数量，不等于「已发布」的语义资产。
        </p>
      </header>

      <form className="jobs__lookup" onSubmit={submit}>
        <label className="jobs__field">
          <span>任务 ID</span>
          <input
            type="text"
            name="jobId"
            data-testid="job-id-input"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
          />
        </label>
        <button type="submit" data-testid="job-load" disabled={busy}>
          加载任务
        </button>
      </form>

      {phase === 'loading' || phase === 'empty' || phase === 'not_configured' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel phase={phase} {...(error === undefined ? {} : { error })} />
      ) : null}

      {phase === 'ready' && job !== undefined ? (
        <div className="jobs__body">
          <ol className="jobs__stages" data-testid="job-stages" data-stage={job.stage}>
            {PIPELINE_STAGES.map((stage) => (
              <li
                key={stage}
                className="jobs__stage"
                data-testid="job-stage"
                data-stage={stage}
                data-current={stage === job.stage}
                data-done={PIPELINE_STAGES.indexOf(stage) < PIPELINE_STAGES.indexOf(job.stage)}
              >
                {STAGE_LABEL[stage]}
              </li>
            ))}
          </ol>

          <div className="jobs__counts" data-testid="job-counts">
            <p data-testid="count-total">
              总数：<strong>{job.counts.total}</strong>
            </p>
            <p data-testid="count-processed" data-label="processed-not-published">
              已处理（非已发布）：<strong>{job.counts.processed}</strong>
            </p>
            <p data-testid="count-failed" data-failed={job.counts.failed > 0}>
              失败：<strong>{job.counts.failed}</strong>
            </p>
            <p data-testid="count-skipped">
              跳过：<strong>{job.counts.skipped}</strong>
            </p>
          </div>

          <div className="jobs__publication" data-testid="job-publication" data-published={published}>
            <h3>已发布</h3>
            {job.publication === undefined ? (
              <p data-testid="published-count" data-count="0">
                已发布：0（处理完成的候选尚未发布为语义资产）
              </p>
            ) : (
              <p data-testid="published-count" data-count="1">
                已发布：1（publication {job.publication.publicationId}）
              </p>
            )}
          </div>

          {failed ? (
            <p className="jobs__failure" data-testid="job-failure" role="alert">
              部分失败：{job.lastError?.code ?? 'FAILED'} — {job.lastError?.message ?? '阶段失败'}
              {job.failedStage === undefined ? '' : `（失败阶段：${STAGE_LABEL[job.failedStage]}）`}
            </p>
          ) : null}

          <div className="jobs__retry">
            <button
              type="button"
              data-testid="job-retry"
              disabled={busy || !isRunnable(job.failedStage)}
              onClick={() => void retry()}
            >
              重试失败阶段（If-Match 修订 {job.revision}）
            </button>
          </div>

          {conflict === undefined ? null : (
            <p className="jobs__conflict" data-testid="job-conflict" data-code={conflict.code} role="alert">
              版本冲突（{conflict.code}）：{conflict.message}。已刷新前请勿覆盖。
            </p>
          )}

          {notice === undefined ? null : (
            <p className="jobs__notice" data-testid="job-notice" role="status">
              {notice}
            </p>
          )}

          <div className="jobs__attempts" data-testid="job-attempts" data-count={job.attempts.length}>
            <h3>尝试记录（{job.attemptCount}）</h3>
            <ul>
              {job.attempts.map((attempt) => (
                <li key={attempt.attemptId} data-testid="job-attempt" data-state={attempt.state}>
                  第 {attempt.attemptNumber} 次 · {attempt.state} · {STAGE_LABEL[attempt.stage]}
                  {attempt.error === undefined ? '' : ` · ${attempt.error.code}`}
                  {attempt.abandonedReason === undefined ? '' : ` · ${attempt.abandonedReason}`}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  )
}
