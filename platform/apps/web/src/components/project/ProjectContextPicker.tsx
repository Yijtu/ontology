import { useEffect, useMemo, useState } from 'react'
import type { ProjectRecord } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import { Field } from '../ui'
import { ProjectNotice } from './ProjectNotice'
import { useRequestFence } from './useRequestFence'

export function useProjectContext(client: WorkbenchClient, projectId?: string) {
  const [selection, setSelection] = useState({ owner: projectId, value: projectId })
  const selectedId = selection.owner === projectId ? selection.value : projectId
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([])
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const scope = useMemo(() => ({ client }), [client])
  const begin = useRequestFence(scope)
  useEffect(() => {
    const request = begin('projects')
    setProjects([])
    setError(undefined)
    setLoading(true)
    void client
      .listProjects({ limit: 200 })
      .then((actual) => {
        if (request.current()) setProjects(actual)
      })
      .catch((caught: unknown) => {
        if (request.current()) setError(caught)
      })
      .finally(() => {
        if (request.current()) setLoading(false)
      })
  }, [client, begin])
  return {
    selectedId,
    select: (value: string | undefined) => setSelection({ owner: projectId, value }),
    projects,
    error,
    loading,
  }
}
export function ProjectContextPicker({
  context,
  onSelect,
}: {
  readonly context: ReturnType<typeof useProjectContext>
  readonly onSelect: (projectId: string | undefined) => void
}) {
  return (
    <div className="project-section">
      <Field label="当前项目" hint="任务将使用服务端固定的当前项目输入；历史答案保持原来的版本。">
        {(attributes) => (
          <select
            {...attributes}
            data-testid="business-project"
            value={context.selectedId ?? ''}
            disabled={context.loading}
            onChange={(event) => onSelect(event.target.value || undefined)}
          >
            <option value="">选择一个项目…</option>
            {context.selectedId === undefined ||
            context.projects.some((project) => project.projectId === context.selectedId) ? null : (
              <option value={context.selectedId}>所选项目（由服务端核对）</option>
            )}
            {context.projects.map((project) => (
              <option
                key={project.projectId}
                value={project.projectId}
                disabled={project.state === 'archived'}
              >
                {project.title} · 修订 {project.headRevision}
                {project.state === 'archived' ? ' · 已归档' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      {context.error === undefined ? null : <ProjectNotice error={context.error} />}
      {context.loading ? (
        <p role="status">正在读取可访问的项目…</p>
      ) : context.projects.length === 0 && context.error === undefined ? (
        <p className="project-source-note">暂无项目。请先在项目资料页创建项目并完成数据确认。</p>
      ) : null}
    </div>
  )
}
