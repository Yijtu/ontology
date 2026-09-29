import { useState } from 'react'
import type { IndustryWorkspace, PipelineStage, ResourceRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { JobView } from '../api/review'
import { ApiError } from '../api/errors'
import type { WorkspaceIdentity } from '../workspace-identity'

/**
 * Source operations for one industry workspace (SPEC v0.3a §5/§9.2, P.US-003.AC-02).
 *
 * An import is a real `POST /api/v1/ingestions`; progress is the real `GET /api/v1/jobs/{id}`
 * projection. The panel keeps file, source revision, media type, processing stage and the parsed
 * counts separate, and it never labels a stage that is still running or partly failed as a full
 * success — `processed` counts handled items, not published assets.
 */

export type SupportedSourceType = 'text' | 'json' | 'csv' | 'xlsx'

export interface WorkspaceSource {
  readonly jobId: string
  readonly fileName: string
  readonly mediaType: SupportedSourceType
  readonly revision: string
  readonly documentSetRef: ResourceRef
  readonly job?: JobView
  readonly jobError?: string
}

export interface WorkspaceSourcesPanelProps {
  readonly client: WorkbenchClient
  readonly workspace: IndustryWorkspace
  readonly identity: WorkspaceIdentity
  readonly readOnly?: boolean
  /** Append a workspace draft revision that registers the new source set. */
  readonly onRegisterSourceSet?: (documentSetRef: ResourceRef, reason: string) => Promise<void>
}

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

const TYPE_LABEL: Readonly<Record<SupportedSourceType, string>> = {
  text: '文本',
  json: 'JSON',
  csv: 'CSV',
  xlsx: 'XLSX',
}

const SOURCE_TYPES: readonly SupportedSourceType[] = ['text', 'json', 'csv', 'xlsx']

function detectType(fileName: string): SupportedSourceType {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return 'text'
}

interface SourceOutcome {
  readonly kind: 'success' | 'partial' | 'processing'
  readonly label: string
}

/**
 * Classify one job's progress. Only a terminal, fully-processed stage with no failures and no
 * skipped rows is a full success; anything else is explicitly partial or still processing.
 */
const PARSED_STAGES: readonly PipelineStage[] = ['validated', 'awaiting_review', 'published']

function outcomeOf(job: JobView): SourceOutcome {
  const terminal = PARSED_STAGES.includes(job.stage)
  const complete = job.counts.total > 0 && job.counts.processed === job.counts.total
  if (terminal && complete && job.counts.failed === 0 && job.counts.skipped === 0) {
    return { kind: 'success', label: '全部成功' }
  }
  if (job.stage === 'failed' || job.counts.failed > 0 || (job.counts.total > 0 && job.counts.processed < job.counts.total)) {
    return { kind: 'partial', label: '部分解析（未计为全量成功）' }
  }
  return { kind: 'processing', label: '处理中' }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : '请求失败。'
}

function canonicalSourcePayload(input: {
  readonly fileName: string
  readonly mediaType: SupportedSourceType
  readonly url: string | undefined
  readonly text: string
}): string {
  return JSON.stringify({
    kind: 'industry-source',
    fileName: input.fileName,
    mediaType: input.mediaType,
    url: input.url ?? null,
    text: input.text,
  })
}

export function WorkspaceSourcesPanel({
  client,
  workspace,
  identity,
  readOnly = false,
  onRegisterSourceSet,
}: WorkspaceSourcesPanelProps) {
  const [sources, setSources] = useState<readonly WorkspaceSource[]>([])
  const [pastedText, setPastedText] = useState('')
  const [chosenName, setChosenName] = useState('')
  const [chosenType, setChosenType] = useState<SupportedSourceType>('text')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const reloadJob = async (jobId: string): Promise<void> => {
    try {
      const job = await client.getJob(jobId)
      setSources((previous) =>
        previous.map((source) => (source.jobId === jobId ? { ...source, job } : source)),
      )
    } catch (error) {
      setSources((previous) =>
        previous.map((source) =>
          source.jobId === jobId ? { ...source, jobError: errorMessage(error) } : source,
        ),
      )
    }
  }

  const submit = async (event: { preventDefault: () => void }): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (chosenName.trim().length === 0) {
      setFailure('请先选择文件或填写资料名称。')
      return
    }
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const revision = String(sources.filter((source) => source.fileName === chosenName).length + 1)
      const digest = await identity.sha256(
        canonicalSourcePayload({ fileName: chosenName, mediaType: chosenType, url: undefined, text: pastedText }),
      )
      const documentSetRef: ResourceRef = {
        id: identity.newId(),
        version: '1.0.0',
        digest,
        kind: 'artifact',
      }
      const created = await client.createIngestion({
        sourceRef: `industry-workspace:${workspace.workspaceId}:${chosenName}`,
        documentRef: `${chosenName}#r${revision}`,
        pipelineVersion: '1.0.0',
      })
      const source: WorkspaceSource = {
        jobId: created.jobId,
        fileName: chosenName,
        mediaType: chosenType,
        revision,
        documentSetRef,
      }
      setSources((previous) => [...previous, source])
      setNotice(`已提交资料 ${chosenName}（修订 ${revision}），解析任务 ${created.jobId}。`)
      setPastedText('')
      setChosenName('')
      setChosenType('text')
      await reloadJob(created.jobId)
      if (onRegisterSourceSet !== undefined) {
        await onRegisterSourceSet(documentSetRef, `register source ${chosenName} revision ${revision}`)
      }
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (readOnly) {
    return (
      <section className="workspace-sources" data-testid="workspace-sources" data-readonly="true">
        <h3>资料</h3>
        <p data-testid="workspace-sources-readonly">只读模式：不显示资料上传入口。</p>
      </section>
    )
  }

  return (
    <section className="workspace-sources" data-testid="workspace-sources">
      <header className="panel__header">
        <h3>资料与解析进度</h3>
        <p className="panel__hint">
          上传或粘贴资料即创建真实解析任务；资料列表显示文件、修订、类型、处理阶段、已解析数量与失败项，
          部分解析不会被写成全量成功。
        </p>
      </header>

      <form className="workspace-sources__form" data-testid="workspace-source-form" onSubmit={(event) => void submit(event)}>
        <label className="workspace-sources__field">
          <span>选择文件</span>
          <input
            type="file"
            data-testid="source-file-input"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file === undefined) return
              setChosenName(file.name)
              setChosenType(detectType(file.name))
              void file.text().then(
                (text) => setPastedText(text),
                () => setFailure('无法读取所选文件内容。'),
              )
            }}
          />
        </label>
        <label className="workspace-sources__field">
          <span>资料名称</span>
          <input
            type="text"
            data-testid="source-name-input"
            value={chosenName}
            disabled={busy}
            onChange={(event) => {
              setChosenName(event.target.value)
              setChosenType(detectType(event.target.value))
            }}
          />
        </label>
        <label className="workspace-sources__field">
          <span>类型</span>
          <select
            data-testid="source-type-select"
            value={chosenType}
            disabled={busy}
            onChange={(event) => setChosenType(event.target.value as SupportedSourceType)}
          >
            {SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="workspace-sources__field workspace-sources__field--wide">
          <span>粘贴文本（无文件时使用）</span>
          <textarea
            data-testid="source-text-input"
            value={pastedText}
            disabled={busy}
            onChange={(event) => setPastedText(event.target.value)}
          />
        </label>
        <button type="submit" data-testid="source-submit" disabled={busy}>
          {busy ? '提交中…' : '导入并解析'}
        </button>
      </form>

      {notice === undefined ? null : (
        <p role="status" data-testid="source-notice">
          {notice}
        </p>
      )}
      {failure === undefined ? null : (
        <p role="alert" data-testid="source-error">
          {failure}
        </p>
      )}

      {sources.length === 0 ? (
        <p data-testid="workspace-sources-empty">尚无资料。</p>
      ) : (
        <table className="workspace-sources__table" data-testid="workspace-source-list">
          <thead>
            <tr>
              <th>文件</th>
              <th>修订</th>
              <th>类型</th>
              <th>处理阶段</th>
              <th>已解析</th>
              <th>失败</th>
              <th>结论</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const job = source.job
              const outcome = job === undefined ? undefined : outcomeOf(job)
              return (
                <tr key={source.jobId} data-testid="workspace-source-row" data-job-id={source.jobId}>
                  <td data-testid="source-file">{source.fileName}</td>
                  <td data-testid="source-revision">{source.revision}</td>
                  <td data-testid="source-type">{TYPE_LABEL[source.mediaType]}</td>
                  <td data-testid="source-stage" data-stage={job?.stage ?? 'loading'}>
                    {job === undefined ? '加载中…' : STAGE_LABEL[job.stage]}
                  </td>
                  <td data-testid="source-processed">
                    {job === undefined ? '—' : `${String(job.counts.processed)}/${String(job.counts.total)}`}
                  </td>
                  <td data-testid="source-failed" data-failed={(job?.counts.failed ?? 0) > 0}>
                    {job === undefined ? '—' : String(job.counts.failed)}
                  </td>
                  <td data-testid="source-outcome" data-kind={outcome?.kind ?? 'loading'}>
                    {source.jobError !== undefined
                      ? `读取进度失败：${source.jobError}`
                      : outcome?.label ?? '加载中…'}
                  </td>
                  <td>
                    <button
                      type="button"
                      data-testid="source-refresh"
                      disabled={busy}
                      onClick={() => void reloadJob(source.jobId)}
                    >
                      刷新进度
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
