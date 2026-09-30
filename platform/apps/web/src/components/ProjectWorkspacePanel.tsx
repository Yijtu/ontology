import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ColumnMappingEntry,
  ImportMappingVersion,
  MappingIssue,
  MappingPreview,
  ProjectRecord,
  ProjectReadinessKind,
  ProjectRecordVersion,
  ProjectRevision,
  ReadinessProjection,
  ResolvedProfileRef,
  ResourceRef,
  MappingRef,
  Sha256Digest,
  StructuredFormat,
  VersionRef,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import { StatePanel } from './StatePanel'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'
import type {
  ColumnMappingRequestView,
  CreateProjectRequest,
  IndustryPackSummary,
  ProjectDatasetStatusView,
  ProjectDocumentIndexStatusView,
  ProjectReadinessView,
} from '../api/projects'

/**
 * The public business-project workspace (SPEC v0.3a asset-data-ui §9.1/§9.2, A.US-002/
 * A.US-006/P.US-012/P.US-013). It lists/creates/continues customer projects, mounts an exact
 * published pack version as a new revision, imports project sources, confirms a two-layer column
 * mapping with a canonical-vs-raw preview, binds and pages records, and shows the independent
 * semantic / dataset / document-index readiness projections with fixable blockers.
 *
 * The panel is generic: it never names an industry and renders no default quotation action. A
 * professional view stays behind the V03-022 mount registry. Every number comes from a guarded
 * HTTP response; a failure is localised and never presented as a success.
 */

/** One parsed source the deployment already uploaded+parsed (the upload/parse seam is upstream). */
export interface ProjectSourceCandidate {
  readonly sourceId: string
  readonly label: string
  readonly format: StructuredFormat
  readonly mediaType: string
  readonly documentRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly parseId: string
  readonly documentId?: string
  readonly objects: readonly ProjectSourceObject[]
}

export interface ProjectSourceObject {
  readonly objectId: string
  readonly label: string
  readonly sheetId?: string
  readonly sheetName?: string
  /** The canonical attributes the object declares, with the required-column flag. */
  readonly fields: readonly ProjectSourceField[]
  /** The parsed source columns, addressed by their stable 0-based index. */
  readonly columns: readonly ProjectSourceColumn[]
}

export interface ProjectSourceField {
  readonly fieldRef: string
  readonly label: string
  readonly valueType: string
  readonly unitCode?: string
  readonly required: boolean
}

export interface ProjectSourceColumn {
  readonly columnIndex: number
  readonly header: string
  readonly headerDigest: Sha256Digest
}

/** The server-resolved pins a project is created against (from the deployment, not user JSON). */
export interface ProjectBinding {
  readonly profileRef: ResolvedProfileRef
  readonly mappingRefs: readonly MappingRef[]
  readonly documentSetRef: ResourceRef
}

export interface ProjectWorkspacePanelProps {
  readonly client: WorkbenchClient
  readonly projectBinding: ProjectBinding
  /** The published pack versions the deployment offers for project creation/mounting. */
  readonly packs: readonly IndustryPackSummary[]
  readonly sources?: readonly ProjectSourceCandidate[]
  readonly readOnly?: boolean
  readonly initialProjectId?: string
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
  return { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '请求无法完成。' }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError && error.permissionDenied) return 'permission_denied'
  return 'failure'
}

function packRefOf(pack: IndustryPackSummary): VersionRef | undefined {
  return pack.packRef
}

function readinessLabel(kind: ProjectReadinessKind): string {
  switch (kind) {
    case 'published_semantics':
      return '语义发布'
    case 'dataset':
      return '查询数据'
    case 'document_index':
      return '文档索引'
  }
}

function projectionFor(
  projections: readonly ReadinessProjection[],
  kind: ProjectReadinessKind,
): ReadinessProjection | undefined {
  return projections.find((projection) => projection.kind === kind)
}

const READINESS_KINDS: readonly ProjectReadinessKind[] = ['published_semantics', 'dataset', 'document_index']

export function ProjectWorkspacePanel({
  client,
  projectBinding,
  packs,
  sources = [],
  readOnly = false,
  initialProjectId,
}: ProjectWorkspacePanelProps) {
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProjectId)
  const [busy, setBusy] = useState(false)

  const [title, setTitle] = useState('')
  const [packChoice, setPackChoice] = useState('')
  const [createErrors, setCreateErrors] = useState<Readonly<Record<string, string>>>({})
  const [createFailure, setCreateFailure] = useState<WorkbenchError | undefined>(undefined)

  const [revisions, setRevisions] = useState<readonly ProjectRevision[]>([])
  const [readiness, setReadiness] = useState<ProjectReadinessView | undefined>(undefined)
  const [mappings, setMappings] = useState<readonly ImportMappingVersion[]>([])
  const [records, setRecords] = useState<readonly ProjectRecordVersion[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [datasetStatus, setDatasetStatus] = useState<ProjectDatasetStatusView | undefined>(undefined)
  const [documentIndex, setDocumentIndex] = useState<ProjectDocumentIndexStatusView | undefined>(undefined)
  const [actionError, setActionError] = useState<WorkbenchError | undefined>(undefined)

  const [mountChoice, setMountChoice] = useState('')
  const [mountReason, setMountReason] = useState('切换行业包版本')
  const [mountResult, setMountResult] = useState<string | undefined>(undefined)

  const [importedSourceId, setImportedSourceId] = useState<string | undefined>(undefined)

  const [sourceId, setSourceId] = useState('')
  const [objectId, setObjectId] = useState('')
  const [columnChoice, setColumnChoice] = useState<Readonly<Record<string, number>>>({})
  const [preview, setPreview] = useState<MappingPreview | undefined>(undefined)
  const [previewError, setPreviewError] = useState<WorkbenchError | undefined>(undefined)
  const [confirmedMapping, setConfirmedMapping] = useState<ImportMappingVersion | undefined>(undefined)

  const [datasetObjectId, setDatasetObjectId] = useState('')
  const [bindNotice, setBindNotice] = useState<string | undefined>(undefined)

  const selected = projects.find((project) => project.projectId === selectedId)
  const activeSource = sources.find((candidate) => candidate.sourceId === sourceId)
  const activeObject = activeSource?.objects.find((object) => object.objectId === objectId)

  const loadList = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const projectList = await client.listProjects()
      setProjects(projectList)
      setSelectedId((previous) => {
        const wanted = previous ?? initialProjectId
        return wanted !== undefined && projectList.some((project) => project.projectId === wanted)
          ? wanted
          : projectList[0]?.projectId
      })
      setPhase(projectList.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client, initialProjectId])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const loadProjectData = useCallback(
    async (projectId: string): Promise<void> => {
      try {
        const [revisionList, readinessView, mappingList, indexStatus] = await Promise.all([
          client.listProjectRevisions(projectId),
          client.getProjectReadiness(projectId),
          client.listProjectMappings(projectId),
          client.getProjectDocumentIndex(projectId),
        ])
        setRevisions(revisionList)
        setReadiness(readinessView)
        setMappings(mappingList)
        setDocumentIndex(indexStatus)
        setActionError(undefined)
      } catch (caught) {
        setActionError(toError(caught))
      }
    },
    [client],
  )

  useEffect(() => {
    if (selectedId === undefined) {
      setRevisions([])
      setReadiness(undefined)
      setMappings([])
      setRecords([])
      setDocumentIndex(undefined)
      return
    }
    void loadProjectData(selectedId)
  }, [selectedId, loadProjectData])

  const refreshRecords = useCallback(
    async (projectId: string, cursor?: string): Promise<void> => {
      const page = await client.listProjectRecords(projectId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      setRecords(page.records)
      setRecordTotal(page.total)
      setNextCursor(page.nextCursor)
    },
    [client],
  )

  const create = async (): Promise<void> => {
    const errors: Record<string, string> = {}
    if (title.trim().length === 0) errors['title'] = '请填写项目名称。'
    if (packChoice.length === 0) errors['pack'] = '请选择一个已发布的行业包版本。'
    setCreateErrors(errors)
    if (Object.keys(errors).length > 0) {
      setCreateFailure({ code: 'INVALID_ARGUMENT', message: '请先修正标记的必填项。' })
      return
    }
    const pack = packs.find((candidate) => `${candidate.packRef?.id ?? ''}@${candidate.packRef?.version ?? ''}` === packChoice)
    const packRef = pack === undefined ? undefined : packRefOf(pack)
    if (packRef === undefined) {
      setCreateFailure({ code: 'INVALID_ARGUMENT', message: '所选行业包缺少版本引用。' })
      return
    }
    setBusy(true)
    setCreateFailure(undefined)
    try {
      const request: CreateProjectRequest = {
        title: title.trim(),
        industryPackRef: packRef,
        profileRef: projectBinding.profileRef,
        mappingRefs: projectBinding.mappingRefs,
        documentSetRef: projectBinding.documentSetRef,
      }
      const result = await client.createProject(request)
      setProjects((previous) => [result.project, ...previous])
      setSelectedId(result.project.projectId)
      setTitle('')
      setPackChoice('')
      setPhase('ready')
    } catch (caught) {
      setCreateFailure(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const mountPack = async (): Promise<void> => {
    if (selected === undefined) return
    const pack = packs.find((candidate) => `${candidate.packRef?.id ?? ''}@${candidate.packRef?.version ?? ''}` === mountChoice)
    const packRef = pack === undefined ? undefined : packRefOf(pack)
    if (packRef === undefined) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请选择一个已发布的行业包版本。' })
      return
    }
    setBusy(true)
    setActionError(undefined)
    setMountResult(undefined)
    try {
      const result = await client.mountProjectPack(selected.projectId, {
        expectedRevision: selected.headRevision,
        industryPackRef: packRef,
        reason: mountReason.trim().length === 0 ? '切换行业包版本' : mountReason.trim(),
      })
      setMountResult(
        `新修订 ${result.revision.ref.revision}；变化：${result.changes.join('、') || '无'}；失效就绪：${
          result.readinessInvalidated.map(readinessLabel).join('、') || '无'
        }`,
      )
      setProjects((previous) =>
        previous.map((project) => (project.projectId === result.project.projectId ? result.project : project)),
      )
      await loadProjectData(result.project.projectId)
    } catch (caught) {
      setActionError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const importSource = async (candidate: ProjectSourceCandidate): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setActionError(undefined)
    try {
      const status = await client.importProjectDocumentMembership(selected.projectId, {
        ...(candidate.documentId === undefined ? {} : { documentId: candidate.documentId }),
        documentRef: candidate.documentRef,
        parseRef: candidate.parseRef,
        parseId: candidate.parseId,
      })
      setDocumentIndex(status)
      setImportedSourceId(candidate.sourceId)
    } catch (caught) {
      setActionError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const buildMappingRequest = useCallback(
    (source: ProjectSourceCandidate, object: ProjectSourceObject, entries: readonly ColumnMappingEntry[]): ColumnMappingRequestView => {
      const options = {
        ...(object.sheetId === undefined ? {} : { sheetId: object.sheetId }),
        ...(object.sheetName === undefined ? {} : { sheetName: object.sheetName }),
      }
      return {
        format: source.format,
        parseId: source.parseId,
        originalRef: source.documentRef,
        originalMediaType: source.mediaType,
        options,
        objectId: object.objectId,
        ...(object.sheetId === undefined ? {} : { sheetId: object.sheetId }),
        ...(object.sheetName === undefined ? {} : { sheetName: object.sheetName }),
        entries,
      }
    },
    [],
  )

  const selectedEntries = useMemo((): readonly ColumnMappingEntry[] => {
    if (activeObject === undefined) return []
    const entries: ColumnMappingEntry[] = []
    for (const field of activeObject.fields) {
      const index = columnChoice[field.fieldRef]
      if (index === undefined) continue
      const column = activeObject.columns.find((candidate) => candidate.columnIndex === index)
      if (column === undefined) continue
      const unit = field.valueType === 'quantity' && field.unitCode !== undefined ? field.unitCode : undefined
      entries.push({
        fieldRef: field.fieldRef,
        header: column.header,
        headerDigest: column.headerDigest,
        columnIndex: column.columnIndex,
        ...(unit === undefined ? {} : { sourceUnitCode: unit, canonicalUnitCode: unit }),
      })
    }
    return entries
  }, [activeObject, columnChoice])

  const previewMapping = async (): Promise<void> => {
    if (selected === undefined || activeSource === undefined || activeObject === undefined) return
    setBusy(true)
    setPreviewError(undefined)
    try {
      const result = await client.previewProjectMapping(
        selected.projectId,
        buildMappingRequest(activeSource, activeObject, selectedEntries),
      )
      setPreview(result)
    } catch (caught) {
      setPreview(undefined)
      setPreviewError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const confirmMapping = async (): Promise<void> => {
    if (selected === undefined || activeSource === undefined || activeObject === undefined) return
    setBusy(true)
    setPreviewError(undefined)
    try {
      const result = await client.confirmProjectMapping(
        selected.projectId,
        buildMappingRequest(activeSource, activeObject, selectedEntries),
      )
      setConfirmedMapping(result.mapping)
      setPreview(result.preview)
      setMappings((previous) => [result.mapping, ...previous])
    } catch (caught) {
      setConfirmedMapping(undefined)
      setPreviewError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const bindRecords = async (): Promise<void> => {
    if (selected === undefined || confirmedMapping === undefined) return
    setBusy(true)
    setActionError(undefined)
    setBindNotice(undefined)
    try {
      const result = await client.bindProjectRecords(selected.projectId, {
        parseId: confirmedMapping.parseId,
        mappingId: confirmedMapping.mappingId,
        mappingVersion: confirmedMapping.version,
      })
      setBindNotice(
        result.created ? `已绑定 ${result.records.length} 条记录。` : `重复导入：复用既有 ${result.records.length} 条记录，未新增。`,
      )
      await refreshRecords(selected.projectId)
    } catch (caught) {
      setActionError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const materialize = async (): Promise<void> => {
    if (selected === undefined || datasetObjectId.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写要物化的对象标识。' })
      return
    }
    setBusy(true)
    setActionError(undefined)
    try {
      const status = await client.materializeProjectDataset(selected.projectId, { objectId: datasetObjectId.trim() })
      setDatasetStatus(status)
      await loadProjectData(selected.projectId)
    } catch (caught) {
      setActionError(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const refreshDataset = async (): Promise<void> => {
    if (selected === undefined || datasetObjectId.trim().length === 0) return
    try {
      setDatasetStatus(await client.getProjectDatasetStatus(selected.projectId, datasetObjectId.trim()))
    } catch (caught) {
      setActionError(toError(caught))
    }
  }

  const nextPage = async (): Promise<void> => {
    if (selected === undefined || nextCursor === undefined) return
    try {
      await refreshRecords(selected.projectId, nextCursor)
    } catch (caught) {
      setActionError(toError(caught))
    }
  }

  return (
    <section className="project-workspace" data-testid="project-workspace" data-phase={phase}>
      <header className="panel__header">
        <h2>项目工作区</h2>
        <p className="panel__hint">创建或继续客户项目，导入资料并确认列映射，查看记录与语义／查询／索引的独立就绪状态。</p>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载项目…' } : {})}
        />
      ) : null}

      {phase === 'empty' ? <p data-testid="project-empty">尚无客户项目。填写下方表单创建第一个项目。</p> : null}

      {phase === 'ready' ? (
        <div className="project-workspace__list" data-testid="project-list">
          <h3>已有项目</h3>
          <ul>
            {projects.map((project) => (
              <li key={project.projectId}>
                <button
                  type="button"
                  data-testid="project-list-item"
                  data-project-id={project.projectId}
                  data-selected={project.projectId === selectedId}
                  aria-pressed={project.projectId === selectedId}
                  onClick={() => setSelectedId(project.projectId)}
                >
                  {project.title}（修订 {project.headRevision} · {project.state}）
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {readOnly ? null : (
        <form
          className="project-workspace__create"
          data-testid="project-create"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy) void create()
          }}
        >
          <h3>新建项目</h3>
          <label className="project-workspace__field">
            <span>项目名称</span>
            <input
              type="text"
              data-testid="project-create-title"
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
            {createErrors['title'] === undefined ? null : (
              <small data-testid="project-create-error-title">{createErrors['title']}</small>
            )}
          </label>
          <label className="project-workspace__field">
            <span>已发布行业包</span>
            <select
              data-testid="project-create-pack"
              value={packChoice}
              disabled={busy}
              onChange={(event) => setPackChoice(event.target.value)}
            >
              <option value="">请选择…</option>
              {packs.filter((pack) => pack.usable && pack.packRef !== undefined).map((pack) => (
                <option key={`${pack.packRef?.id ?? ''}@${pack.packRef?.version ?? ''}`} value={`${pack.packRef?.id ?? ''}@${pack.packRef?.version ?? ''}`}>
                  {pack.displayName} {pack.packRef?.version ?? ''}
                </option>
              ))}
            </select>
            {createErrors['pack'] === undefined ? null : (
              <small data-testid="project-create-error-pack">{createErrors['pack']}</small>
            )}
          </label>
          <button type="submit" data-testid="project-create-submit" disabled={busy}>
            {busy ? '保存中…' : '创建项目'}
          </button>
          {createFailure === undefined ? null : (
            <p role="alert" data-testid="project-create-failure" data-code={createFailure.code}>
              {createFailure.code}：{createFailure.message}
            </p>
          )}
        </form>
      )}

      {selected === undefined ? null : (
        <div className="project-workspace__detail" data-testid="project-detail" data-project-id={selected.projectId}>
          <h3 data-testid="project-detail-title">{selected.title}</h3>
          <dl>
            <dt>当前修订</dt>
            <dd data-testid="project-detail-head-revision">{selected.headRevision}</dd>
            <dt>状态</dt>
            <dd data-testid="project-detail-state">{selected.state}</dd>
            <dt>修订数</dt>
            <dd data-testid="project-detail-revision-count">{revisions.length}</dd>
          </dl>

          {readOnly ? null : (
            <div className="project-workspace__mount" data-testid="project-mount">
              <h4>挂载／切换行业包版本</h4>
              <select
                data-testid="project-mount-pack"
                value={mountChoice}
                disabled={busy}
                onChange={(event) => setMountChoice(event.target.value)}
              >
                <option value="">请选择…</option>
                {packs.filter((pack) => pack.usable && pack.packRef !== undefined).map((pack) => (
                  <option key={`${pack.packRef?.id ?? ''}@${pack.packRef?.version ?? ''}`} value={`${pack.packRef?.id ?? ''}@${pack.packRef?.version ?? ''}`}>
                    {pack.displayName} {pack.packRef?.version ?? ''}
                  </option>
                ))}
              </select>
              <input
                type="text"
                data-testid="project-mount-reason"
                value={mountReason}
                disabled={busy}
                onChange={(event) => setMountReason(event.target.value)}
              />
              <button type="button" data-testid="project-mount-submit" disabled={busy} onClick={() => void mountPack()}>
                挂载为新修订
              </button>
              {mountResult === undefined ? null : (
                <p data-testid="project-mount-result">{mountResult}</p>
              )}
            </div>
          )}

          <section className="project-workspace__readiness" data-testid="project-readiness">
            <h4>就绪状态（语义／查询／索引独立）</h4>
            <ul data-testid="readiness-list">
              {READINESS_KINDS.map((kind) => {
                const projection = projectionFor(readiness?.projections ?? [], kind)
                return (
                  <li key={kind} data-testid="readiness-row" data-kind={kind} data-state={projection?.state ?? 'missing'}>
                    <span data-testid={`readiness-label-${kind}`}>{readinessLabel(kind)}</span>
                    <span data-testid={`readiness-state-${kind}`}>{projection?.state ?? '未构建'}</span>
                    {projection === undefined ? null : (
                      <span data-testid={`readiness-counts-${kind}`}>
                        {projection.processedCount}/{projection.expectedCount}，失败 {projection.failedCount}
                      </span>
                    )}
                    {projection?.error === undefined ? null : (
                      <span data-testid={`readiness-error-${kind}`} data-code={projection.error.code}>
                        {projection.error.message}
                        {projection.error.retryable ? '（可重试）' : '（不可重试）'}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {readiness === undefined ? null : readiness.blockers.length > 0 ? (
              <ul data-testid="readiness-blockers">
                {readiness.blockers.map((blocker) => (
                  <li key={`${blocker.code}:${blocker.readinessKind ?? ''}`} data-testid="readiness-blocker" data-code={blocker.code}>
                    {blocker.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="readiness-ready">所需投影均已就绪。</p>
            )}
          </section>

          <section className="project-workspace__sources" data-testid="project-sources">
            <h4>资料导入</h4>
            {sources.length === 0 ? (
              <p data-testid="sources-empty">暂无已解析的可导入资料。</p>
            ) : (
              <ul>
                {sources.map((candidate) => (
                  <li key={candidate.sourceId} data-testid="source-candidate" data-source-id={candidate.sourceId}>
                    <span data-testid={`source-label-${candidate.sourceId}`}>{candidate.label}（{candidate.format.toUpperCase()}）</span>
                    {readOnly ? null : (
                      <button
                        type="button"
                        data-testid={`source-import-${candidate.sourceId}`}
                        disabled={busy}
                        onClick={() => void importSource(candidate)}
                      >
                        导入到项目
                      </button>
                    )}
                    {importedSourceId === candidate.sourceId ? (
                      <span data-testid={`source-imported-${candidate.sourceId}`}>已导入</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div data-testid="document-index" data-state={documentIndex?.state ?? 'missing'}>
              <h5>文档索引</h5>
              <p data-testid="document-index-state">状态：{documentIndex?.state ?? '未构建'}</p>
              {documentIndex === undefined ? null : (
                <p data-testid="document-index-counts">
                  源文件 {documentIndex.sourceDocumentCount}，片段 {documentIndex.documentCount}，完整性 {documentIndex.completeness}
                </p>
              )}
              {documentIndex?.reason === undefined ? null : (
                <p data-testid="document-index-reason">{documentIndex.reason}</p>
              )}
              {readOnly || documentIndex === undefined ? null : (
                <button
                  type="button"
                  data-testid="document-index-build"
                  disabled={busy}
                  onClick={() => {
                    if (selected === undefined) return
                    void client.buildProjectDocumentIndex(selected.projectId).then(setDocumentIndex).catch((caught: unknown) => setActionError(toError(caught)))
                  }}
                >
                  构建索引
                </button>
              )}
            </div>
          </section>

          <section className="project-workspace__mapping" data-testid="project-mapping">
            <h4>列映射确认</h4>
            {mappings.length === 0 ? null : (
              <ul data-testid="mapping-list">
                {mappings.map((mapping) => (
                  <li key={`${mapping.mappingId}@${mapping.version}`} data-testid="mapping-list-item">
                    {mapping.objectId} · {mapping.mappingId}@{mapping.version}
                  </li>
                ))}
              </ul>
            )}
            <label className="project-workspace__field">
              <span>选择资料</span>
              <select
                data-testid="mapping-source"
                value={sourceId}
                disabled={busy}
                onChange={(event) => {
                  setSourceId(event.target.value)
                  setObjectId('')
                  setColumnChoice({})
                  setPreview(undefined)
                }}
              >
                <option value="">请选择…</option>
                {sources.map((candidate) => (
                  <option key={candidate.sourceId} value={candidate.sourceId}>{candidate.label}</option>
                ))}
              </select>
            </label>
            <label className="project-workspace__field">
              <span>选择对象</span>
              <select
                data-testid="mapping-object"
                value={objectId}
                disabled={busy}
                onChange={(event) => {
                  setObjectId(event.target.value)
                  setColumnChoice({})
                  setPreview(undefined)
                }}
              >
                <option value="">请选择…</option>
                {(activeSource?.objects ?? []).map((object) => (
                  <option key={object.objectId} value={object.objectId}>{object.label}</option>
                ))}
              </select>
            </label>

            {activeObject === undefined ? null : (
              <table data-testid="mapping-fields">
                <thead>
                  <tr><th>规范字段</th><th>来源列</th></tr>
                </thead>
                <tbody>
                  {activeObject.fields.map((field) => (
                    <tr key={field.fieldRef} data-testid={`mapping-field-${field.fieldRef}`} data-required={field.required}>
                      <td>{field.label}{field.required ? ' *' : ''}</td>
                      <td>
                        <select
                          data-testid={`mapping-column-${field.fieldRef}`}
                          value={columnChoice[field.fieldRef] === undefined ? '' : String(columnChoice[field.fieldRef])}
                          disabled={busy || readOnly}
                          onChange={(event) =>
                            setColumnChoice((previous) => {
                              const next = { ...previous }
                              if (event.target.value === '') delete next[field.fieldRef]
                              else next[field.fieldRef] = Number(event.target.value)
                              return next
                            })
                          }
                        >
                          <option value="">未映射</option>
                          {activeObject.columns.map((column) => (
                            <option key={column.columnIndex} value={String(column.columnIndex)}>
                              {column.header}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {readOnly ? null : (
              <div className="project-workspace__mapping-actions">
                <button
                  type="button"
                  data-testid="mapping-preview-button"
                  disabled={busy || activeObject === undefined}
                  onClick={() => void previewMapping()}
                >
                  预览规范值
                </button>
                <button
                  type="button"
                  data-testid="mapping-confirm-button"
                  disabled={busy || activeObject === undefined}
                  onClick={() => void confirmMapping()}
                >
                  确认映射
                </button>
              </div>
            )}

            {previewError === undefined ? null : (
              <p role="alert" data-testid="mapping-failure" data-code={previewError.code}>
                {previewError.code}：{previewError.message}
              </p>
            )}

            {preview === undefined ? null : (
              <div data-testid="mapping-preview" data-confirmable={preview.confirmable}>
                <p data-testid="mapping-preview-rows">数据行 {preview.rowCount}</p>
                <ul data-testid="mapping-issues">
                  {preview.issues.map((mappingIssue: MappingIssue, index) => (
                    <li key={`${mappingIssue.code}:${String(index)}`} data-testid="mapping-issue" data-code={mappingIssue.code} data-severity={mappingIssue.severity}>
                      {mappingIssue.code}：{mappingIssue.message}
                    </li>
                  ))}
                </ul>
                <table data-testid="mapping-preview-table">
                  <thead>
                    <tr><th>规范字段</th><th>原始值</th><th>规范值</th></tr>
                  </thead>
                  <tbody>
                    {preview.columns.map((column) => (
                      <tr key={column.fieldRef} data-testid={`mapping-preview-${column.fieldRef}`} data-normalization={column.normalization}>
                        <td>{column.fieldRef}</td>
                        <td>{column.samples[0]?.raw ?? '—'}</td>
                        <td>{column.samples[0]?.canonical ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p data-testid="mapping-preview-confirmable">{preview.confirmable ? '可确认' : '存在阻断项，不可确认'}</p>
              </div>
            )}

            {confirmedMapping === undefined ? null : (
              <p data-testid="mapping-confirmed" data-mapping-id={confirmedMapping.mappingId}>
                已确认映射 {confirmedMapping.mappingId}@{confirmedMapping.version}
              </p>
            )}
            {bindNotice === undefined ? null : <p data-testid="bind-notice">{bindNotice}</p>}
            {readOnly || confirmedMapping === undefined ? null : (
              <button type="button" data-testid="record-bind" disabled={busy} onClick={() => void bindRecords()}>
                绑定记录
              </button>
            )}
          </section>

          <section className="project-workspace__dataset" data-testid="project-dataset">
            <h4>查询数据集</h4>
            <label className="project-workspace__field">
              <span>对象标识</span>
              <input
                type="text"
                data-testid="dataset-object"
                value={datasetObjectId}
                disabled={busy}
                onChange={(event) => setDatasetObjectId(event.target.value)}
              />
            </label>
            <button type="button" data-testid="dataset-status-refresh" disabled={busy} onClick={() => void refreshDataset()}>
              查看状态
            </button>
            {readOnly ? null : (
              <button type="button" data-testid="dataset-materialize" disabled={busy} onClick={() => void materialize()}>
                物化数据集
              </button>
            )}
            {datasetStatus === undefined ? null : (
              <p data-testid="dataset-status" data-state={datasetStatus.state}>
                状态：{datasetStatus.state}，完整性 {datasetStatus.completeness}
                {datasetStatus.reason === undefined ? '' : `；${datasetStatus.reason}`}
              </p>
            )}
          </section>

          <section className="project-workspace__records" data-testid="project-records">
            <h4>项目记录</h4>
            <p data-testid="record-total">共 {recordTotal} 条</p>
            {records.length === 0 ? (
              <p data-testid="record-empty">当前页无记录。</p>
            ) : (
              <table data-testid="record-table">
                <thead>
                  <tr><th>记录</th><th>对象</th><th>状态</th><th>字段</th></tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.recordId} data-testid="record-row" data-record-id={record.recordId} data-status={record.status}>
                      <td data-testid="record-id">{record.recordId}</td>
                      <td>{record.objectId}</td>
                      <td data-testid="record-status">{record.status}</td>
                      <td>
                        {record.fields.map((field) => (
                          <span key={field.fieldId} data-testid={`record-field-${field.fieldId}`} data-status={field.status}>
                            {field.fieldId}：{field.raw === null ? '∅' : String(field.raw)} →{' '}
                            {field.normalized.kind === 'quantity'
                              ? `${field.normalized.value} ${field.normalized.unitCode}`
                              : String(field.normalized.value ?? '∅')}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {nextCursor === undefined ? null : (
              <button type="button" data-testid="record-next" onClick={() => void nextPage()}>
                下一页
              </button>
            )}
          </section>

          {actionError === undefined ? null : (
            <p role="alert" data-testid="project-action-error" data-code={actionError.code}>
              {actionError.code}：{actionError.message}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
