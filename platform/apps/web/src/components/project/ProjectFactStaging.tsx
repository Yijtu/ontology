import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImportMappingVersion, InstanceRecordView, ProjectRecordVersion } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import type { ProjectSourceCatalogue } from '../../api/project-workbench'
import { stageProjectFacts } from '../../api/project-facts'
import type { StagedProjectCandidate } from '../../api/project-facts'
import { Button } from '../ui'
import { ProjectNotice } from './ProjectNotice'
import { useRequestFence } from './useRequestFence'

export function ProjectFactStaging({
  client,
  projectId,
  rows,
  mappings,
  catalogue,
  readOnly,
  onReview,
  onRefresh,
}: {
  readonly client: WorkbenchClient
  readonly projectId: string
  readonly rows: readonly ProjectRecordVersion[]
  readonly mappings: readonly ImportMappingVersion[]
  readonly catalogue?: ProjectSourceCatalogue
  readonly readOnly: boolean
  readonly onReview: (recordId?: string) => void
  readonly onRefresh: () => void
}) {
  const [staged, setStaged] = useState<readonly StagedProjectCandidate[]>([])
  const [reviewed, setReviewed] = useState<readonly InstanceRecordView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const keys = useRef(new Map<string, string>())
  const scope = useMemo(() => ({ client, projectId, rows, catalogue }), [client, projectId, rows, catalogue])
  const begin = useRequestFence(scope)
  useEffect(() => {
    setStaged([])
    setReviewed([])
    setError(undefined)
    setBusy(false)
  }, [scope])
  useEffect(() => {
    keys.current.clear()
  }, [client, projectId])
  const eligible = rows.filter(
    (row) =>
      row.status === 'confirmed' &&
      row.fields.length > 0 &&
      row.fields.every(
        (field) =>
          field.status === 'confirmed' &&
          (field.normalized.kind !== 'scalar' || field.normalized.value !== null),
      ),
  )
  const retainedKey = (name: string) => {
    const existing = keys.current.get(name)
    if (existing !== undefined) return existing
    const key = client.newRequestKey()
    keys.current.set(name, key)
    return key
  }
  const stage = async () => {
    if (
      readOnly ||
      busy ||
      eligible.length === 0 ||
      catalogue === undefined ||
      catalogue.project.projectId !== projectId
    )
      return
    const request = begin('stage')
    setBusy(true)
    setError(undefined)
    setStaged([])
    setReviewed([])
    const completed: StagedProjectCandidate[] = []
    try {
      const groups = new Map<string, ProjectRecordVersion[]>()
      for (const row of eligible) {
        const mapping = mappings.find(
          (entry) => entry.mappingId === row.mappingId && entry.version === row.mappingVersion,
        )
        if (
          mapping === undefined ||
          !catalogue.revision.mappingRefs.some(
            (ref) =>
              ref.id === mapping.ref.id &&
              ref.version === mapping.ref.version &&
              ref.digest === mapping.ref.digest,
          )
        )
          throw new Error('有记录缺少当前修订中的确认映射，请刷新后核对。')
        const sources = catalogue.sources.filter(
          (source) =>
            source.parseId === mapping.parseId &&
            source.originalRef.id === mapping.originalRef.id &&
            source.originalRef.version === mapping.originalRef.version &&
            source.originalRef.digest === mapping.originalRef.digest,
        )
        if (sources.length !== 1 || sources[0] === undefined)
          throw new Error('无法唯一确定该记录对应的当前原始文件。')
        const documentId = sources[0].documentId
        groups.set(documentId, [...(groups.get(documentId) ?? []), row])
      }
      for (const [documentId, selected] of groups) {
        const candidates = await stageProjectFacts(
          client,
          projectId,
          documentId,
          selected,
          retainedKey(
            `stage:${documentId}:${selected.map((row) => `${row.recordId}:${row.revision}`).join(',')}`,
          ),
          request.signal,
        )
        if (!request.current()) return
        completed.push(...candidates)
        setStaged([...completed])
      }
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const createReviews = async () => {
    if (readOnly || busy || staged.length === 0) return
    const request = begin('reviews')
    setBusy(true)
    setError(undefined)
    setReviewed([])
    try {
      const existing = await client.listInstanceRecords(projectId)
      if (!request.current()) return
      const actual: InstanceRecordView[] = []
      for (const candidate of staged) {
        const matches = existing.filter(
          (entry) =>
            entry.identity.binding?.candidateId === candidate.candidateId &&
            entry.identity.binding.documentId === candidate.documentId,
        )
        if (matches.length > 1) throw new Error('同一候选存在多个审核记录，无法唯一确定。')
        const record =
          matches[0] ??
          (await client.createInstanceRecord(
            projectId,
            { candidateId: candidate.candidateId, documentId: candidate.documentId },
            retainedKey(`review:${candidate.candidateId}:${candidate.documentId}`),
          ))
        if (!request.current()) return
        actual.push(record)
        setReviewed([...actual])
      }
      onReview(actual[0]?.recordId)
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  return (
    <section className="project-section" data-testid="project-fact-staging">
      <h4>送审映射记录</h4>
      <p>当前页 {eligible.length} 条记录的字段已完成映射与规范化。生成候选后，仍需人工核对字段与身份。</p>
      <div className="project-actions">
        <Button
          variant="primary"
          data-testid="project-stage-facts"
          disabled={readOnly || busy || eligible.length === 0 || catalogue === undefined}
          onClick={() => void stage()}
        >
          {busy ? '正在处理…' : `生成当前页 ${eligible.length} 条候选`}
        </Button>
        {staged.length === 0 ? null : (
          <Button
            data-testid="project-create-reviews"
            disabled={readOnly || busy}
            onClick={() => void createReviews()}
          >
            创建待审记录并核对
          </Button>
        )}
      </div>
      {staged.length === 0 ? null : (
        <p role="status">
          已生成 {staged.length} 条候选 · 已读取或创建 {reviewed.length} 条待审记录。
        </p>
      )}
      {error === undefined ? null : <ProjectNotice error={error} onRecover={onRefresh} />}
    </section>
  )
}
