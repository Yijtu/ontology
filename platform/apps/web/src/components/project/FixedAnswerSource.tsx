import { useEffect, useMemo, useState } from 'react'
import type { PublishedAnswer, ResourceRef } from '@ontology/contracts'
import type { AnswerSourceLoader, AnswerSourceView } from '../../api/source-views'
import { boundAnswerSource } from '../../api/source-views'
import { AnswerSourceContent } from './AnswerSourceContent'
import { ProjectNotice } from './ProjectNotice'
import { useRequestFence } from './useRequestFence'

export function FixedAnswerSource({
  answer,
  reference,
  loadSource,
}: {
  readonly answer: PublishedAnswer
  readonly reference: ResourceRef
  readonly loadSource: AnswerSourceLoader
}) {
  const [view, setView] = useState<AnswerSourceView>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const scope = useMemo(
    () => ({ answerId: answer.answerId, hash: answer.contentHash, reference, loadSource }),
    [answer.answerId, answer.contentHash, reference, loadSource],
  )
  const begin = useRequestFence(scope)
  const [loadedScope, setLoadedScope] = useState<unknown>()
  useEffect(() => {
    setView(undefined)
    setError(undefined)
    setLoading(false)
    if (reference.kind !== 'evidence') return
    const request = begin('source')
    setLoading(true)
    void loadSource(answer, reference, request.signal)
      .then((actual) => {
        if (request.current()) {
          setView(boundAnswerSource(actual, answer, reference))
          setLoadedScope(scope)
        }
      })
      .catch((caught: unknown) => {
        if (request.current()) setError(caught)
      })
      .finally(() => {
        if (request.current()) setLoading(false)
      })
  }, [answer, reference, loadSource, begin, scope])
  return (
    <>
      {loading ? <p role="status">正在读取所选答案的固定来源…</p> : null}
      {reference.kind === 'evidence' ? null : (
        <p>此为文件或工件引用，请从该陈述的证据来源查看原文与原始单元格。</p>
      )}
      {error === undefined ? null : <ProjectNotice error={error} />}
      {view === undefined || loadedScope !== scope ? null : (
        <AnswerSourceContent key={`${view.answerId}:${view.evidenceId}`} view={view} />
      )}
    </>
  )
}
