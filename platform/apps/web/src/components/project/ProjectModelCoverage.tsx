import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchClient } from '../../api/client'
import { ApiError } from '../../api/errors'
import { readEffectiveModels } from '../../api/model-connections'
import type { EffectiveModelSelection } from '../../api/model-connections'
import { EffectiveModelSummary } from '../EffectiveModelSummary'
import '../project/project-workbench.css'

type Phase = 'loading' | 'ready' | 'forbidden' | 'error'

/**
 * The effective model for the current project (design §5.2/§5.3, N10). It resolves the project
 * scope, so a project's own override wins and a project never inherits the pack author's
 * workspace model settings: the resolver walks object → space, never the authoring workspace.
 * A missing or blocked model is shown with its stable reason and never silently switches vendor;
 * it does not disable existing sources, history or deterministic paths.
 */
export function ProjectModelCoverage({
  client,
  projectId,
  onConfigure,
}: {
  readonly client: WorkbenchClient
  readonly projectId?: string
  readonly onConfigure?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [selections, setSelections] = useState<readonly EffectiveModelSelection[]>([])
  const token = useRef(0)
  const live = useRef(true)
  const controller = useRef<AbortController | undefined>(undefined)

  const load = useCallback(
    async (id: string) => {
      const request = ++token.current
      controller.current?.abort()
      const next = new AbortController()
      controller.current = next
      setPhase('loading')
      try {
        const result = await readEffectiveModels(client, { kind: 'project', projectId: id }, undefined, next.signal)
        if (!live.current || token.current !== request || next.signal.aborted) return
        setSelections(result)
        setPhase('ready')
      } catch (error) {
        if (!live.current || token.current !== request || next.signal.aborted) return
        setSelections([])
        setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
      }
    },
    [client],
  )

  useEffect(() => {
    live.current = true
    if (projectId === undefined) {
      setSelections([])
      setPhase('ready')
      return
    }
    void load(projectId)
    return () => {
      live.current = false
      controller.current?.abort()
    }
  }, [load, projectId])

  return (
    <section className="project-model-coverage" data-testid="project-model-coverage" data-phase={phase}>
      <header className="project-section__head">
        <div>
          <h4>本项目生效模型（新任务）</h4>
          <p className="project-source-note">
            按项目解析：项目自身覆盖优先，其次空间默认；不继承行业包作者工作区的模型设置。
          </p>
        </div>
        {onConfigure === undefined ? null : (
          <button type="button" data-testid="project-model-configure" onClick={onConfigure}>
            前往 AI 设置
          </button>
        )}
      </header>
      {projectId === undefined ? (
        <p data-testid="project-model-none" className="project-source-note">
          先选择项目以查看其生效模型。
        </p>
      ) : phase === 'forbidden' ? (
        <p data-testid="project-model-forbidden" className="project-source-note">
          当前账户无权查看生效模型；此处不显示模型名称、数量或地址。
        </p>
      ) : phase === 'error' ? (
        <p data-testid="project-model-error" className="project-source-note" role="alert">
          暂时无法解析生效模型，请稍后重试。
        </p>
      ) : phase === 'loading' ? (
        <p data-testid="project-model-loading" className="project-source-note" role="status">
          正在解析本项目生效模型…
        </p>
      ) : (
        <div className="model-effective__list">
          {selections.map((selection) => (
            <EffectiveModelSummary
              key={selection.capability}
              selection={selection}
              variant="compact"
              {...(onConfigure === undefined ? {} : { onConfigure })}
            />
          ))}
        </div>
      )}
    </section>
  )
}
