import { useEffect, useState } from 'react'
import type { CoreDeploymentScenario, WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'

export interface CoreImportPanelProps {
  readonly client: WorkbenchClient
  readonly scenarios: readonly CoreDeploymentScenario[]
  readonly initialScenarioId?: string
  readonly operatorEnabled?: boolean
  readonly generationEnabled?: boolean
  readonly onImported?: (jobId: string) => void
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : '导入请求失败。'
}

export function CoreImportPanel({ client, scenarios, initialScenarioId, operatorEnabled = false, generationEnabled = false, onImported }: CoreImportPanelProps) {
  const initialScenario = scenarios.find((scenario) => scenario.scenarioId === initialScenarioId) ?? scenarios[0]
  const [scenarioId, setScenarioId] = useState(initialScenario?.scenarioId ?? '')
  const [sourceId, setSourceId] = useState(initialScenario?.rawSourceRefs[0]?.sourceId ?? '')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const scenario = scenarios.find((entry) => entry.scenarioId === scenarioId)
  const source = scenario?.rawSourceRefs.find((entry) => entry.sourceId === sourceId) ?? scenario?.rawSourceRefs[0]

  useEffect(() => {
    if (!scenarios.some((entry) => entry.scenarioId === scenarioId)) {
      const first = scenarios[0]
      setScenarioId(first?.scenarioId ?? '')
      setSourceId(first?.rawSourceRefs[0]?.sourceId ?? '')
    }
  }, [scenarioId, scenarios])

  if (scenarios.length === 0) return null

  return (
    <section className="core-import" data-testid="core-import-panel">
      <header className="panel__header">
        <h3>导入原始记录</h3>
        <p className="panel__hint">
          选择已挂载的来源并粘贴{generationEnabled ? 'UTF-8原始文档或JSON记录' : '带强身份键的JSON记录'}。
          {generationEnabled
            ? '系统先尝试原生字段映射，其余内容走已配置的提取模型并进入候选审核。'
            : '没有生成模型时，非原生文本会被明确拒绝。'}
          本地 API 还需由操作者显式启用导入权限。
        </p>
      </header>
      <form
        className="core-import__form"
        onSubmit={(event) => {
          event.preventDefault()
          if (scenario === undefined || source === undefined || content.trim().length === 0 || busy) return
          if (!operatorEnabled) {
            setFailure('原始导入需要由本地操作者显式启用权限。')
            return
          }
          setBusy(true)
          setNotice(undefined)
          setFailure(undefined)
          void client.createCoreImport({ scenarioId: scenario.scenarioId, sourceId: source.sourceId, content })
            .then((result) => {
              setNotice(`已创建解析任务 ${result.jobId}（${result.stage}）。`)
              setContent('')
              onImported?.(result.jobId)
            })
            .catch((error: unknown) => setFailure(errorMessage(error)))
            .finally(() => setBusy(false))
        }}
      >
        <label>
          场景
          <select
            data-testid="core-import-scenario"
            value={scenarioId}
            disabled={busy}
            onChange={(event) => {
              const next = scenarios.find((entry) => entry.scenarioId === event.target.value)
              setScenarioId(event.target.value)
              setSourceId(next?.rawSourceRefs[0]?.sourceId ?? '')
            }}
          >
            {scenarios.map((entry) => <option key={entry.scenarioId} value={entry.scenarioId}>{entry.label}</option>)}
          </select>
        </label>
        <label>
          已声明来源
          <select
            data-testid="core-import-source"
            value={source?.sourceId ?? ''}
            disabled={busy || scenario === undefined}
            onChange={(event) => setSourceId(event.target.value)}
          >
            {(scenario?.rawSourceRefs ?? []).map((entry) => (
              <option key={`${entry.namespace}/${entry.sourceId}`} value={entry.sourceId}>
                {entry.namespace}/{entry.sourceId}
              </option>
            ))}
          </select>
        </label>
        <label>
          原始文档内容
          <textarea
            data-testid="core-import-content"
            value={content}
            disabled={busy}
            placeholder={generationEnabled ? 'UTF-8文本或JSON对象块；来源快照会被原样归档。' : '每条记录一个JSON对象，且字段需映射到已配置强身份键。'}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <button type="submit" data-testid="core-import-submit" disabled={!operatorEnabled || busy || source === undefined || content.trim().length === 0}>
          {busy ? '提交中…' : '导入并解析'}
        </button>
      </form>
      {notice === undefined ? null : <p role="status" data-testid="core-import-notice">{notice}</p>}
      {failure === undefined ? null : <p role="alert" data-testid="core-import-error">{failure}</p>}
    </section>
  )
}
