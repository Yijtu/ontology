import { useMemo, useState } from 'react'
import type { ProjectRevision } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import type { ProjectRevisionView } from '../../api/projects'
import { Button } from '../ui'
import { ProjectNotice } from './ProjectNotice'
import { readinessStatusLabel } from '../../state/project-labels'
import { useRequestFence } from './useRequestFence'

export function ProjectRevisionHistory({
  client,
  projectId,
  revisions,
  activeRevision,
}: {
  readonly client: WorkbenchClient
  readonly projectId: string
  readonly revisions: readonly ProjectRevision[]
  readonly activeRevision: string
}) {
  const [selected, setSelected] = useState<ProjectRevisionView>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const scope = useMemo(() => ({ client, projectId }), [client, projectId])
  const begin = useRequestFence(scope)
  const [owner, setOwner] = useState<unknown>()
  const select = async (revision: ProjectRevision) => {
    const request = begin('revision')
    setBusy(true)
    setError(undefined)
    setSelected(undefined)
    try {
      const actual = await client.getProjectRevisionView(projectId, revision.ref.revision)
      if (!request.current()) return
      if (
        actual.revision.ref.projectId !== projectId ||
        actual.revision.ref.revision !== revision.ref.revision ||
        actual.revision.ref.digest !== revision.ref.digest
      )
        throw new Error('保存修订的版本与选择不一致，已停止展示。')
      setSelected(actual)
      setOwner(scope)
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const current = owner === scope ? selected : undefined
  return (
    <section className="project-section">
      <h4>保存的项目修订</h4>
      <p className="project-source-note">
        按固定版本读取历史。旧答案中的数据与来源，从对应的已保存运行结果回看。
      </p>
      <ol className="project-history-list">
        {revisions.map((revision) => (
          <li key={revision.ref.digest}>
            <Button
              disabled={busy}
              onClick={() => void select(revision)}
              aria-current={current?.revision.ref.digest === revision.ref.digest ? 'true' : undefined}
            >
              修订 {revision.ref.revision}
              {revision.ref.revision === activeRevision ? ' · 当前活动版本' : ''}
              <small>{revision.changeReason}</small>
            </Button>
          </li>
        ))}
      </ol>
      {busy ? <p role="status">正在读取保存修订…</p> : null}
      {error === undefined ? null : <ProjectNotice error={error} />}
      {current === undefined ? null : (
        <div>
          <h4>修订 {current.revision.ref.revision} · 固定版本</h4>
          <p>{current.revision.changeReason}</p>
          <p>
            行业包版本 {current.revision.industryPackRef.version} · 映射 {current.revision.mappingRefs.length}{' '}
            项 · 已保存发布 {current.revision.semanticPublicationRefs.length} 项
          </p>
          <ul>
            {current.readiness.map((projection) => (
              <li key={projection.kind}>
                {projection.kind === 'dataset'
                  ? '查询数据'
                  : projection.kind === 'document_index'
                    ? '文档索引'
                    : '语义发布'}
                ：{readinessStatusLabel(projection.state)} · {projection.processedCount}/
                {projection.expectedCount}
              </li>
            ))}
          </ul>
          <details className="project-audit">
            <summary>固定引用与摘要</summary>
            <p>
              <code>{current.revision.ref.digest}</code>
            </p>
            <p>
              资料集：
              <code>
                {current.revision.documentSetRef.id}@{current.revision.documentSetRef.version}
              </code>
            </p>
            <p>
              <code>{current.revision.documentSetRef.digest}</code>
            </p>
            <p>
              定义：
              <code>
                {current.revision.definitionRef.id}@{current.revision.definitionRef.version}
              </code>
            </p>
          </details>
        </div>
      )}
    </section>
  )
}
