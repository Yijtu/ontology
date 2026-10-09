import { useEffect, useMemo, useState } from 'react'
import type { PublishedAnswer, ResourceRef } from '@ontology/contracts'
import type { AnswerSourceLoader, AnswerSourceView } from '../../api/source-views'
import { boundAnswerSource } from '../../api/source-views'
import { Button } from '../ui'
import { ProjectNotice } from './ProjectNotice'
import { SourceFragmentContent } from './SourceFragmentContent'
import { useRequestFence } from './useRequestFence'

/** A free summary is never rendered. Only fixed, authorized original-cell projections qualify. */
export function StructuredQaStatement({
  answer,
  references,
  loadSource,
  onOpen,
}: {
  readonly answer: PublishedAnswer
  readonly references: readonly ResourceRef[]
  readonly loadSource: AnswerSourceLoader
  readonly onOpen?: (ref: ResourceRef) => void
}) {
  const [selected, setSelected] = useState<ResourceRef | undefined>(
    references.length === 1 ? references[0] : undefined,
  )
  const [view, setView] = useState<AnswerSourceView>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(false)
  const scope = useMemo(
    () => ({ answerId: answer.answerId, hash: answer.contentHash, ref: selected, loadSource }),
    [answer.answerId, answer.contentHash, selected, loadSource],
  )
  const begin = useRequestFence(scope)
  const [loadedScope, setLoadedScope] = useState<unknown>()
  useEffect(() => {
    setView(undefined)
    setError(undefined)
    setLoading(false)
    if (selected === undefined) return
    const request = begin('qa-source')
    setLoading(true)
    void loadSource(answer, selected, request.signal)
      .then((source) => {
        if (!request.current()) return
        const bound = boundAnswerSource(source, answer, selected)
        if (bound.family !== 'structured_qa' || bound.precision !== 'approximate')
          throw new Error('该摘要缺少可安全展示的结构化原始来源。')
        setView(bound)
        setLoadedScope(scope)
      })
      .catch((caught: unknown) => {
        if (request.current()) setError(caught)
      })
      .finally(() => {
        if (request.current()) setLoading(false)
      })
  }, [answer, selected, loadSource, begin, scope])
  const current = loadedScope === scope ? view : undefined
  return (
    <section data-testid="published-structured-qa" className="project-section">
      <h4>结构化资料中的相关内容</h4>
      <p className="project-source-note">以下按所选答案的固定原文件版本读取；结构化投影保持近似状态。</p>
      {references.length <= 1 ? null : (
        <div className="project-actions">
          {references.map((ref, index) => (
            <Button
              key={`${ref.id}:${ref.digest}`}
              onClick={() => setSelected(ref)}
              aria-pressed={selected?.id === ref.id && selected.digest === ref.digest}
            >
              来源 {index + 1}
            </Button>
          ))}
        </div>
      )}
      {selected === undefined ? <p>选择一条已绑定来源，查看实际单元格。</p> : null}
      {loading ? <p role="status">正在核对原始单元格…</p> : null}
      {error === undefined ? null : <ProjectNotice error={error} />}
      {current === undefined ? null : current.readability === 'unverifiable' ? (
        <p role="alert">原始来源当前无法核验，此投影不能作为可用内容展示。</p>
      ) : (
        <>
          <span className="project-state project-state--partial">
            近似投影 · {current.readability === 'archived_snapshot_only' ? '仅归档快照' : '可重读原文件'}
          </span>
          {(current.fragments ?? [current]).map((fragment, index, fragments) => <SourceFragmentContent key={`${fragment.originalRef?.id}:${fragment.originalRef?.digest}:${JSON.stringify(fragment.locator ?? index)}`} fragment={fragment} {...(fragments.length > 1 ? { label: `来源片段 ${index + 1}` } : {})} />)}
          {onOpen === undefined || selected === undefined ? null : (
            <Button variant="quiet" onClick={() => onOpen(selected)}>
              查看原始单元格与定位 ↗
            </Button>
          )}
        </>
      )}
    </section>
  )
}
