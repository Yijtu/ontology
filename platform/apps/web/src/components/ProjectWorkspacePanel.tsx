import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  ProfileRef,
  StructuredParseOptions,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import { StatePanel } from './StatePanel'
import { PublicEmptyState, PublicStateNotice } from './PublicStateNotice'
import { classifyPublicError } from '../state/public-errors'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'
import type {
  ColumnMappingRequestView,
  IndustryPackSummary,
  ProjectDatasetStatusView,
  ProjectDocumentIndexStatusView,
  ProjectReadinessView,
} from '../api/projects'
import { useRequestFence } from './project/useRequestFence'
import { formatLocator } from './project/VerifiedCell'
import './project/project-workbench.css'
import { bootstrapProject, readProjectSources } from '../api/project-workbench'
import type { ProjectSourceCatalogue } from '../api/project-workbench'
import { ProjectFileImport } from './project/ProjectFileImport'
import { ProjectNotice } from './project/ProjectNotice'
import { ProjectFactStaging } from './project/ProjectFactStaging'
import { NativeSourcePreview } from './project/NativeSourcePreview'
import { InstanceReviewPanel } from './InstanceReviewPanel'
import { ProjectEvolutionPanel } from './project/ProjectEvolutionPanel'
import { MappingValuePairs } from './project/MappingValuePairs'
import { ProjectRevisionHistory } from './project/ProjectRevisionHistory'
import { readinessStatusLabel } from '../state/project-labels'

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
  readonly options?: Omit<StructuredParseOptions, 'mediaType'>
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
  readonly enumValues?: readonly string[]
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
  readonly projectBinding?: ProjectBinding
  readonly profileRef?: ProfileRef
  /** The published pack versions the deployment offers for project creation/mounting. */
  readonly packs: readonly IndustryPackSummary[]
  readonly sources?: readonly ProjectSourceCandidate[]
  readonly readOnly?: boolean
  readonly initialProjectId?: string
  readonly onSelectProject?: (projectId: string) => void
  readonly initialEvolutionId?: string
  readonly onEvolution?: (evolutionId: string) => void
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      missingCapabilities: error.missingCapabilities,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : '请求无法完成。',
    retryable: true,
  }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError && error.permissionDenied) return 'permission_denied'
  return 'failure'
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
  profileRef,
  packs,
  readOnly = false,
  initialProjectId,
  onSelectProject,
  initialEvolutionId,
  onEvolution,
}: ProjectWorkspacePanelProps) {
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [loadedProjects, setProjects] = useState<readonly ProjectRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProjectId)
  const activeProfile = profileRef ?? projectBinding?.profileRef
  const scope = useMemo(
    () => ({ client, selectedId, profileId: activeProfile?.id, version: activeProfile?.version }),
    [client, selectedId, activeProfile?.id, activeProfile?.version],
  )
  const listScope = useMemo(() => ({ client, initialProjectId }), [client, initialProjectId])
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'overview' | 'import' | 'mapping' | 'records' | 'review' | 'history'>(
    'overview',
  )
  const [reviewNonce, setReviewNonce] = useState(0)
  const [reviewRecordId, setReviewRecordId] = useState<string>()
  const [reviewOwner, setReviewOwner] = useState<unknown>()

  const [title, setTitle] = useState('')
  const [createErrors, setCreateErrors] = useState<Readonly<Record<string, string>>>({})
  const [createFailure, setCreateFailure] = useState<WorkbenchError | undefined>(undefined)

  const [loadedRevisions, setRevisions] = useState<readonly ProjectRevision[]>([])
  const [loadedReadiness, setReadiness] = useState<ProjectReadinessView | undefined>(undefined)
  const [loadedMappings, setMappings] = useState<readonly ImportMappingVersion[]>([])
  const [loadedRecords, setRecords] = useState<readonly ProjectRecordVersion[]>([])
  const [loadedRecordTotal, setRecordTotal] = useState(0)
  const [loadedNextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadedDatasetStatus, setDatasetStatus] = useState<ProjectDatasetStatusView | undefined>(undefined)
  const [loadedDocumentIndex, setDocumentIndex] = useState<ProjectDocumentIndexStatusView | undefined>(
    undefined,
  )
  const [actionError, setActionError] = useState<WorkbenchError | undefined>(undefined)

  const [sourceId, setSourceId] = useState('')
  const [objectId, setObjectId] = useState('')
  const [columnChoice, setColumnChoice] = useState<Readonly<Record<string, number>>>({})
  const [loadedPreview, setPreview] = useState<MappingPreview | undefined>(undefined)
  const [previewError, setPreviewError] = useState<WorkbenchError | undefined>(undefined)
  const [loadedConfirmedMapping, setConfirmedMapping] = useState<ImportMappingVersion | undefined>(undefined)
  const [previewRequest, setPreviewRequest] = useState<string>()
  const [sourceUnits, setSourceUnits] = useState<Readonly<Record<string, string>>>({})
  const [conversions, setConversions] = useState<
    Readonly<Record<string, { numerator: string; denominator: string }>>
  >({})
  const [valueMappings, setValueMappings] = useState<
    Readonly<Record<string, readonly { readonly from: string; readonly to: string }[]>>
  >({})

  const [datasetObjectId, setDatasetObjectId] = useState('')
  const [bindNotice, setBindNotice] = useState<string | undefined>(undefined)
  const [loadedCatalogue, setCatalogue] = useState<ProjectSourceCatalogue>()
  const [catalogueError, setCatalogueError] = useState<unknown>()
  const [listOwner, setListOwner] = useState<unknown>()
  const [projectOwner, setProjectOwner] = useState<unknown>()
  const [recordsOwner, setRecordsOwner] = useState<unknown>()
  const [catalogueOwner, setCatalogueOwner] = useState<unknown>()
  const [mappingOwner, setMappingOwner] = useState<unknown>()
  const [datasetOwner, setDatasetOwner] = useState<unknown>()
  const [indexOwner, setIndexOwner] = useState<unknown>()
  const projects = listOwner === listScope ? loadedProjects : []
  const revisions = projectOwner === scope ? loadedRevisions : []
  const readiness = projectOwner === scope ? loadedReadiness : undefined
  const mappings = projectOwner === scope ? loadedMappings : []
  const records = recordsOwner === scope ? loadedRecords : []
  const recordTotal = recordsOwner === scope ? loadedRecordTotal : 0
  const nextCursor = recordsOwner === scope ? loadedNextCursor : undefined
  const documentIndex = indexOwner === scope ? loadedDocumentIndex : undefined
  const catalogue = catalogueOwner === scope ? loadedCatalogue : undefined
  const createKey = useRef<{ serialized: string; key: string } | undefined>(undefined)
  const writeKeys = useRef(new Map<string, string>())
  const retainedKey = (name: string, input: unknown) => {
    const serialized = JSON.stringify({ name, projectId: selectedId, input })
    const prior = writeKeys.current.get(serialized)
    if (prior !== undefined) return prior
    const key = client.newRequestKey()
    writeKeys.current.set(serialized, key)
    return key
  }
  const sources: readonly ProjectSourceCandidate[] = useMemo(() => {
    if (catalogue === undefined || catalogue.project.projectId !== selectedId) return []
    return catalogue.sources.flatMap((source) => {
      const format = source.format ?? source.kind
      if (format !== 'csv' && format !== 'xlsx' && format !== 'json' && format !== 'text') return []
      if (source.mediaType === undefined || source.options === undefined) return []
      const nativeOptions = source.options
      const mediaType = source.mediaType
      return (source.tables ?? []).map((table) => ({
        sourceId: `${source.documentId}:${table.tableId}`,
        label: `${source.name ?? '原始资料'}${table.name === undefined ? '' : ` · ${table.name}`}`,
        format,
        mediaType,
        documentId: source.documentId,
        documentRef: source.originalRef,
        parseRef: source.parseRef,
        parseId: source.parseId,
        options: nativeOptions,
        objects: catalogue.objects.map((object) => ({
          objectId: object.objectId,
          label: object.displayName,
          ...(table.sheetId === undefined ? {} : { sheetId: table.sheetId }),
          ...(table.sheetName === undefined ? {} : { sheetName: table.sheetName }),
          fields: object.attributes.map((field) => ({
            fieldRef: field.attributeId,
            label: field.displayName,
            valueType: field.valueType,
            required: field.required,
            ...(field.unit === undefined ? {} : { unitCode: field.unit }),
            ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }),
          })),
          columns: table.columns,
        })),
      }))
    })
  }, [catalogue, selectedId])

  const selected =
    phase === 'ready' ? projects.find((project) => project.projectId === selectedId) : undefined
  const currentReviewRecordId = reviewOwner === scope ? reviewRecordId : undefined
  const activeRevision = revisions.find(
    (entry) =>
      entry.ref.projectId === selectedId &&
      entry.ref.revision === (selected?.activeRevision ?? selected?.headRevision),
  )
  const activeSource = sources.find((candidate) => candidate.sourceId === sourceId)
  const activeObject = activeSource?.objects.find((object) => object.objectId === objectId)
  const begin = useRequestFence(scope)
  const datasetScope = useMemo(() => ({ scope, datasetObjectId }), [scope, datasetObjectId])
  const beginDataset = useRequestFence(datasetScope)
  const datasetStatus = datasetOwner === datasetScope ? loadedDatasetStatus : undefined
  const beginList = useRequestFence(listScope)
  const reloadCatalogue = useCallback(
    async (projectId: string) => {
      const request = begin('catalogue')
      setCatalogueError(undefined)
      try {
        const actual = await readProjectSources(client, projectId, request.signal)
        if (request.current()) {
          setCatalogue(actual)
          setCatalogueOwner(scope)
          setProjects((previous) =>
            previous.map((entry) => (entry.projectId === actual.project.projectId ? actual.project : entry)),
          )
        }
      } catch (caught) {
        if (request.current()) {
          setCatalogue(undefined)
          setCatalogueError(caught)
        }
      }
    },
    [client, begin, scope],
  )

  const loadList = useCallback(async (): Promise<void> => {
    const request = beginList('list')
    setPhase('loading')
    try {
      const projectList = await client.listProjects()
      if (!request.current()) return
      setProjects(projectList)
      setListOwner(listScope)
      setSelectedId((previous) => {
        const wanted = previous ?? initialProjectId
        return wanted !== undefined && projectList.some((project) => project.projectId === wanted)
          ? wanted
          : projectList[0]?.projectId
      })
      setPhase(projectList.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      if (!request.current()) return
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client, initialProjectId, beginList, listScope])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const loadProjectData = useCallback(
    async (projectId: string): Promise<void> => {
      const request = begin('project')
      try {
        const [revisionList, readinessView, mappingList, indexStatus] = await Promise.all([
          client.listProjectRevisions(projectId),
          client.getProjectReadiness(projectId),
          client.listProjectMappings(projectId),
          client.getProjectDocumentIndex(projectId),
        ])
        if (!request.current()) return
        if (
          revisionList.some((entry) => entry.ref.projectId !== projectId) ||
          readinessView.projectRevisionRef.projectId !== projectId ||
          mappingList.some((entry) => entry.projectId !== projectId) ||
          indexStatus.projectId !== projectId
        )
          throw new Error('项目回读范围不一致，已停止展示。')
        setProjectOwner(scope)
        setIndexOwner(scope)
        setRevisions(revisionList)
        setReadiness(readinessView)
        setMappings(mappingList)
        setDocumentIndex(indexStatus)
        setActionError(undefined)
      } catch (caught) {
        if (request.current()) setActionError(toError(caught))
      }
    },
    [client, begin, scope],
  )

  useEffect(() => {
    setRevisions([])
    setReadiness(undefined)
    setMappings([])
    setRecords([])
    setRecordTotal(0)
    setNextCursor(undefined)
    setDocumentIndex(undefined)
    setDatasetStatus(undefined)
    setActionError(undefined)
    setPreview(undefined)
    setPreviewRequest(undefined)
    setConfirmedMapping(undefined)
    setPreviewError(undefined)
    setBindNotice(undefined)
    setSourceId('')
    setObjectId('')
    setColumnChoice({})
    setSourceUnits({})
    setConversions({})
    setValueMappings({})
    setDatasetObjectId('')
    setBusy(false)
    writeKeys.current.clear()
    if (selectedId === undefined) {
      setRevisions([])
      setReadiness(undefined)
      setMappings([])
      setRecords([])
      setDocumentIndex(undefined)
      return
    }
    void loadProjectData(selectedId)
    setCatalogue(undefined)
    setCatalogueError(undefined)
    void reloadCatalogue(selectedId)
  }, [selectedId, loadProjectData, reloadCatalogue])

  const refreshRecords = useCallback(
    async (projectId: string, cursor?: string): Promise<void> => {
      const request = begin('records')
      try {
        const page = await client.listProjectRecords(projectId, {
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
        })
        if (!request.current()) return
        if (page.records.some((entry) => entry.projectId !== projectId))
          throw new Error('记录页不属于当前项目。')
        setRecordsOwner(scope)
        setRecords(page.records)
        setRecordTotal(page.total)
        setNextCursor(page.nextCursor)
      } catch (caught) {
        if (request.current()) throw caught
      }
    },
    [client, begin, scope],
  )

  useEffect(() => {
    if (selectedId !== undefined)
      void refreshRecords(selectedId).catch((caught: unknown) => setActionError(toError(caught)))
  }, [selectedId, refreshRecords])
  useEffect(() => {
    if (selectedId !== undefined) onSelectProject?.(selectedId)
  }, [selectedId, onSelectProject])

  const create = async (): Promise<void> => {
    const errors: Record<string, string> = {}
    if (title.trim().length === 0) errors['title'] = '请填写项目名称。'
    if (activeProfile === undefined) errors['pack'] = '请先选择一个已注册的场景。'
    setCreateErrors(errors)
    if (Object.keys(errors).length > 0) {
      setCreateFailure({ code: 'INVALID_ARGUMENT', message: '请先修正标记的必填项。' })
      return
    }
    if (activeProfile === undefined) return
    const body = { title: title.trim(), profileRef: { id: activeProfile.id, version: activeProfile.version } }
    const serialized = JSON.stringify(body)
    if (createKey.current?.serialized !== serialized)
      createKey.current = { serialized, key: client.newRequestKey() }
    const request = begin('create')
    setBusy(true)
    setCreateFailure(undefined)
    try {
      const result = await bootstrapProject(client, body, createKey.current.key, request.signal)
      if (!request.current()) return
      beginList('list')
      setListOwner(listScope)
      setProjects((previous) => [
        result.project,
        ...(listOwner === listScope
          ? previous.filter((entry) => entry.projectId !== result.project.projectId)
          : []),
      ])
      setSelectedId(result.project.projectId)
      setTitle('')
      createKey.current = undefined
      setPhase('ready')
    } catch (caught) {
      if (request.current()) setCreateFailure(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }

  const buildMappingRequest = useCallback(
    (
      source: ProjectSourceCandidate,
      object: ProjectSourceObject,
      entries: readonly ColumnMappingEntry[],
    ): ColumnMappingRequestView => {
      const options = source.options ?? {}
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
      const unit = field.valueType === 'quantity' ? sourceUnits[field.fieldRef]?.trim() : undefined
      const conversion = conversions[field.fieldRef]
      entries.push({
        fieldRef: field.fieldRef,
        header: column.header,
        headerDigest: column.headerDigest,
        columnIndex: column.columnIndex,
        ...(unit === undefined || unit.length === 0 ? {} : { sourceUnitCode: unit }),
        ...(field.unitCode === undefined ? {} : { canonicalUnitCode: field.unitCode }),
        ...(valueMappings[field.fieldRef] === undefined
          ? {}
          : { valueMapping: valueMappings[field.fieldRef] }),
        ...(unit === undefined || field.unitCode === undefined || conversion === undefined
          ? {}
          : {
              unitConversion: {
                fromUnitCode: unit,
                toUnitCode: field.unitCode,
                numerator: conversion.numerator,
                denominator: conversion.denominator,
              },
            }),
      })
    }
    return entries
  }, [activeObject, columnChoice, sourceUnits, conversions, valueMappings])
  const entriesSignature = JSON.stringify(selectedEntries)
  const mappingScope = useMemo(
    () => ({
      client,
      selectedId,
      sourceId,
      objectId,
      entriesSignature,
      definition: catalogue?.revision.definitionRef.digest,
    }),
    [client, selectedId, sourceId, objectId, entriesSignature, catalogue?.revision.definitionRef.digest],
  )
  const beginMapping = useRequestFence(mappingScope)
  const preview = mappingOwner === mappingScope ? loadedPreview : undefined
  const confirmedMapping = mappingOwner === mappingScope ? loadedConfirmedMapping : undefined
  useEffect(() => {
    setPreview(undefined)
    setPreviewRequest(undefined)
    setConfirmedMapping(undefined)
    setPreviewError(undefined)
  }, [mappingScope])

  const previewMapping = async (): Promise<void> => {
    if (selected === undefined || activeSource === undefined || activeObject === undefined) return
    const request = beginMapping('mapping')
    const body = buildMappingRequest(activeSource, activeObject, selectedEntries)
    setBusy(true)
    setPreviewError(undefined)
    try {
      const result = await client.previewProjectMapping(selected.projectId, body)
      if (!request.current()) return
      setPreview(result)
      setMappingOwner(mappingScope)
      setPreviewRequest(JSON.stringify(body))
    } catch (caught) {
      if (!request.current()) return
      setPreview(undefined)
      setPreviewError(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }

  const confirmMapping = async (): Promise<void> => {
    if (
      selected === undefined ||
      activeSource === undefined ||
      activeObject === undefined ||
      preview?.confirmable !== true
    )
      return
    const body = buildMappingRequest(activeSource, activeObject, selectedEntries)
    if (JSON.stringify(body) !== previewRequest) return
    const request = beginMapping('mapping')
    setBusy(true)
    setPreviewError(undefined)
    try {
      const result = await client.confirmProjectMapping(
        selected.projectId,
        body,
        retainedKey('mapping', body),
      )
      if (!request.current()) return
      setMappingOwner(mappingScope)
      setConfirmedMapping(result.mapping)
      setPreview(result.preview)
      setMappings((previous) => [result.mapping, ...previous])
      await reloadCatalogue(selected.projectId)
      await loadProjectData(selected.projectId)
    } catch (caught) {
      if (!request.current()) return
      setConfirmedMapping(undefined)
      setPreviewError(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }

  const bindRecords = async (): Promise<void> => {
    if (selected === undefined || confirmedMapping === undefined) return
    const request = begin('mutation')
    setBusy(true)
    setActionError(undefined)
    setBindNotice(undefined)
    try {
      const body = {
        parseId: confirmedMapping.parseId,
        mappingId: confirmedMapping.mappingId,
        mappingVersion: confirmedMapping.version,
      }
      const result = await client.bindProjectRecords(selected.projectId, body, retainedKey('bind', body))
      if (!request.current()) return
      setBindNotice(
        result.created
          ? `已绑定 ${result.records.length} 条记录。`
          : `重复导入：复用既有 ${result.records.length} 条记录，未新增。`,
      )
      await refreshRecords(selected.projectId)
    } catch (caught) {
      if (request.current()) setActionError(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }

  const materialize = async (): Promise<void> => {
    if (selected === undefined || datasetObjectId.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写要物化的对象标识。' })
      return
    }
    const request = begin('mutation')
    setBusy(true)
    setActionError(undefined)
    try {
      const body = {
        objectId: datasetObjectId.trim(),
      }
      const status = await client.materializeProjectDataset(
        selected.projectId,
        body,
        retainedKey('dataset', body),
      )
      if (!request.current()) return
      setDatasetStatus(status)
      setDatasetOwner(datasetScope)
      await loadProjectData(selected.projectId)
    } catch (caught) {
      if (request.current()) setActionError(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }

  const refreshDataset = async (): Promise<void> => {
    if (selected === undefined || datasetObjectId.trim().length === 0) return
    const request = beginDataset('dataset')
    try {
      const status = await client.getProjectDatasetStatus(selected.projectId, datasetObjectId.trim())
      if (request.current()) {
        setDatasetStatus(status)
        setDatasetOwner(datasetScope)
      }
    } catch (caught) {
      if (request.current()) setActionError(toError(caught))
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
    <section className="project-workspace project-page" data-testid="project-workspace" data-phase={phase}>
      <header className="project-page__head">
        <div>
          <h2>项目资料与记录</h2>
          <p className="panel__hint">
            创建或继续客户项目，导入资料并确认列映射，查看记录与语义／查询／索引的独立就绪状态。
          </p>
        </div>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载项目…' } : {})}
          {...(phase === 'failure' ? { onRecover: () => void loadList() } : {})}
        />
      ) : null}

      {phase === 'empty' ? (
        <PublicEmptyState
          testId="project-empty"
          title="尚无客户项目"
          requirement="一份已发布的行业包版本，以及要导入的项目资料。"
          nextStep="在下方填写项目名称并选择已发布行业包，创建第一个项目。"
        />
      ) : null}

      <div className="project-two-column">
        <aside className="project-queue">
          {phase === 'ready' ? (
            <div className="project-workspace__list" data-testid="project-list">
              <h3>已有项目</h3>
              <ul className="project-queue__items">
                {projects.map((project) => (
                  <li key={project.projectId}>
                    <button
                      className="project-queue__item"
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
            <details className="project-create-disclosure" open={projects.length === 0}>
              <summary>＋ 新建项目</summary>
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
                <div className="project-workspace__field">
                  <p data-testid="project-create-pack">
                    {activeProfile === undefined
                      ? '请先选择已注册的场景。'
                      : '使用当前场景的已发布版本。服务端将固定行业包、映射与资料集。'}
                  </p>
                  {createErrors['pack'] === undefined ? null : (
                    <small data-testid="project-create-error-pack">{createErrors['pack']}</small>
                  )}
                </div>
                <button type="submit" data-testid="project-create-submit" disabled={busy}>
                  {busy ? '保存中…' : '创建项目'}
                </button>
                {createFailure === undefined ? null : (
                  <PublicStateNotice
                    testId="project-create-failure"
                    failure={classifyPublicError(createFailure)}
                    onRecover={() => void create()}
                  />
                )}
              </form>
            </details>
          )}
        </aside>
        <main className="project-canvas">
          {selected === undefined ? null : (
            <div
              className="project-workspace__detail project-canvas__body"
              data-testid="project-detail"
              data-project-id={selected.projectId}
            >
              <h3 data-testid="project-detail-title">{selected.title}</h3>
              {selected.activeRevision !== undefined && selected.activeRevision !== selected.headRevision ? (
                <p className="project-notice">
                  活动修订 {selected.activeRevision} 继续提供业务查询；待发布修订 {selected.headRevision}{' '}
                  尚未切换。
                </p>
              ) : null}
              <details className="project-audit">
                <summary>当前项目版本</summary>
                <dl>
                  <dt>当前修订</dt>
                  <dd data-testid="project-detail-head-revision">{selected.headRevision}</dd>
                  <dt>状态</dt>
                  <dd data-testid="project-detail-state">{selected.state}</dd>
                  <dt>修订数</dt>
                  <dd data-testid="project-detail-revision-count">{revisions.length}</dd>
                </dl>
              </details>
              <ol className="project-flow" aria-label="项目工作步骤">
                {(
                  [
                    ['overview', '项目概览'],
                    ['import', '导入资料'],
                    ['mapping', '确认映射'],
                    ['records', '项目记录'],
                    ['review', '字段与身份'],
                    ['history', '版本演进'],
                  ] as const
                ).map(([value, label]) => (
                  <li key={value}>
                    <button
                      type="button"
                      aria-current={step === value ? 'step' : undefined}
                      onClick={() => {
                        setStep(value)
                        if (value === 'overview' || value === 'records') {
                          void loadProjectData(selected.projectId)
                          void reloadCatalogue(selected.projectId)
                          void refreshRecords(selected.projectId).catch((caught: unknown) =>
                            setActionError(toError(caught)),
                          )
                        }
                      }}
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ol>

              {step !== 'history' ? null : (
                <>
                  <ProjectEvolutionPanel
                    client={client}
                    project={selected}
                    {...(activeRevision === undefined ? {} : { revision: activeRevision })}
                    packs={packs}
                    mappings={mappings}
                    {...(catalogue === undefined ? {} : { catalogue })}
                    readOnly={readOnly}
                    {...(initialEvolutionId === undefined ? {} : { initialEvolutionId })}
                    {...(onEvolution === undefined ? {} : { onEvolution })}
                    onChanged={() => {
                      void loadProjectData(selected.projectId)
                      void reloadCatalogue(selected.projectId)
                      void loadList()
                    }}
                    onReview={(recordId) => {
                      setReviewRecordId(recordId)
                      setReviewOwner(scope)
                      setReviewNonce((value) => value + 1)
                      setStep('review')
                    }}
                  />
                  <ProjectRevisionHistory
                    client={client}
                    projectId={selected.projectId}
                    revisions={revisions}
                    activeRevision={selected.activeRevision ?? selected.headRevision}
                  />
                </>
              )}

              <section
                className="project-workspace__readiness"
                data-testid="project-readiness"
                hidden={step !== 'overview'}
              >
                <h4>就绪状态（语义／查询／索引独立）</h4>
                <ul data-testid="readiness-list">
                  {READINESS_KINDS.map((kind) => {
                    const projection = projectionFor(readiness?.projections ?? [], kind)
                    return (
                      <li
                        key={kind}
                        data-testid="readiness-row"
                        data-kind={kind}
                        data-state={projection?.state ?? 'missing'}
                      >
                        <span data-testid={`readiness-label-${kind}`}>{readinessLabel(kind)}</span>
                        <span data-testid={`readiness-state-${kind}`}>
                          {projection === undefined ? '未构建' : readinessStatusLabel(projection.state)}
                        </span>
                        {projection === undefined ? null : (
                          <span data-testid={`readiness-counts-${kind}`}>
                            {projection.processedCount}/{projection.expectedCount}，失败{' '}
                            {projection.failedCount}
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
                      <li
                        key={`${blocker.code}:${blocker.readinessKind ?? ''}`}
                        data-testid="readiness-blocker"
                        data-code={blocker.code}
                      >
                        {blocker.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p data-testid="readiness-ready">所需投影均已就绪。</p>
                )}
              </section>

              <section
                className="project-workspace__sources"
                data-testid="project-sources"
                hidden={step !== 'import'}
              >
                <h4>资料导入</h4>
                <ProjectFileImport
                  client={client}
                  projectId={selected.projectId}
                  readOnly={readOnly}
                  onImported={async () => {
                    await reloadCatalogue(selected.projectId)
                    await loadProjectData(selected.projectId)
                  }}
                />
                {catalogue === undefined || catalogue.project.projectId !== selected.projectId ? null : (
                  <NativeSourcePreview catalogue={catalogue} />
                )}
                {catalogueError === undefined ? null : (
                  <ProjectNotice
                    error={catalogueError}
                    onRecover={() => void reloadCatalogue(selected.projectId)}
                  />
                )}
                {catalogue?.sources.some(
                  (source) => source.mediaType === undefined || source.options === undefined,
                ) === true ? (
                  <p role="alert">
                    有原始资料缺少已保存的媒体类型或解析选择，暂不能用于映射。请刷新目录或重新解析该文件。
                  </p>
                ) : null}
                {sources.length === 0 ? (
                  <PublicEmptyState
                    testId="sources-empty"
                    title="暂无可映射的结构化资料"
                    requirement="原始文件已解析，目录包含真实表头与解析选择。"
                    nextStep="在本页上传原始 CSV、XLSX 或 JSON，完成解析后继续确认映射。"
                  />
                ) : (
                  <ul>
                    {sources.map((candidate) => (
                      <li
                        key={candidate.sourceId}
                        data-testid="source-candidate"
                        data-source-id={candidate.sourceId}
                      >
                        <span data-testid={`source-label-${candidate.sourceId}`}>
                          {candidate.label}（{candidate.format.toUpperCase()}）
                        </span>
                        <button
                          type="button"
                          className="project-source-button"
                          onClick={() => {
                            setSourceId(candidate.sourceId)
                            setObjectId('')
                            setColumnChoice({})
                            setStep('mapping')
                          }}
                        >
                          确认这份资料的映射
                        </button>
                        <span>已保存为项目来源</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div data-testid="document-index" data-state={documentIndex?.state ?? 'missing'}>
                  <h5>文档索引</h5>
                  <p data-testid="document-index-state">
                    状态：{documentIndex === undefined ? '未构建' : readinessStatusLabel(documentIndex.state)}
                  </p>
                  {documentIndex === undefined ? null : (
                    <p data-testid="document-index-counts">
                      源文件 {documentIndex.sourceDocumentCount}，片段 {documentIndex.documentCount}，完整性{' '}
                      {documentIndex.completeness}
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
                        const request = begin('index')
                        void client
                          .buildProjectDocumentIndex(
                            selected.projectId,
                            retainedKey('index', { revision: catalogue?.revision.ref }),
                          )
                          .then((status) => {
                            if (request.current()) {
                              setDocumentIndex(status)
                              setIndexOwner(scope)
                            }
                          })
                          .catch((caught: unknown) => {
                            if (request.current()) setActionError(toError(caught))
                          })
                      }}
                    >
                      构建索引
                    </button>
                  )}
                </div>
              </section>

              <section
                className="project-workspace__mapping"
                data-testid="project-mapping"
                hidden={step !== 'mapping'}
              >
                <h4>列映射确认</h4>
                {mappings.length === 0 ? null : (
                  <details className="project-audit">
                    <summary>现有映射版本 · {mappings.length}</summary>
                    <ul data-testid="mapping-list">
                      {mappings.map((mapping) => (
                        <li key={`${mapping.mappingId}@${mapping.version}`} data-testid="mapping-list-item">
                          {mapping.objectId} · {mapping.mappingId}@{mapping.version}
                        </li>
                      ))}
                    </ul>
                  </details>
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
                      setValueMappings({})
                      setSourceUnits({})
                      setConversions({})
                      setPreview(undefined)
                    }}
                  >
                    <option value="">请选择…</option>
                    {sources.map((candidate) => (
                      <option key={candidate.sourceId} value={candidate.sourceId}>
                        {candidate.label}
                      </option>
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
                      setValueMappings({})
                      setSourceUnits({})
                      setConversions({})
                      setPreview(undefined)
                    }}
                  >
                    <option value="">请选择…</option>
                    {(activeSource?.objects ?? []).map((object) => (
                      <option key={object.objectId} value={object.objectId}>
                        {object.label}
                      </option>
                    ))}
                  </select>
                </label>

                {activeObject === undefined ? null : (
                  <table data-testid="mapping-fields">
                    <thead>
                      <tr>
                        <th>规范字段</th>
                        <th>来源列</th>
                        <th>来源单位与换算</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeObject.fields.map((field) => (
                        <tr
                          key={field.fieldRef}
                          data-testid={`mapping-field-${field.fieldRef}`}
                          data-required={field.required}
                        >
                          <td>
                            {field.label}
                            {field.required ? ' *' : ''}
                            {field.valueType !== 'boolean' && field.valueType !== 'enum' ? null : (
                              <MappingValuePairs
                                pairs={valueMappings[field.fieldRef] ?? []}
                                values={
                                  field.valueType === 'boolean' ? ['true', 'false'] : (field.enumValues ?? [])
                                }
                                disabled={busy || readOnly}
                                onChange={(pairs) =>
                                  setValueMappings((previous) => ({ ...previous, [field.fieldRef]: pairs }))
                                }
                              />
                            )}
                          </td>
                          <td>
                            <select
                              data-testid={`mapping-column-${field.fieldRef}`}
                              value={
                                columnChoice[field.fieldRef] === undefined
                                  ? ''
                                  : String(columnChoice[field.fieldRef])
                              }
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
                          <td>
                            {field.valueType !== 'quantity' ? (
                              '无需单位'
                            ) : (
                              <div className="project-unit-inputs">
                                <label>
                                  来源单位
                                  <input
                                    aria-label={`${field.label}来源单位`}
                                    value={sourceUnits[field.fieldRef] ?? ''}
                                    disabled={busy || readOnly}
                                    onChange={(event) =>
                                      setSourceUnits((previous) => ({
                                        ...previous,
                                        [field.fieldRef]: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                                <small>规范单位：{field.unitCode ?? '服务端未声明'}</small>
                                <details>
                                  <summary>精确比例换算</summary>
                                  <label>
                                    分子
                                    <input
                                      aria-label={`${field.label}换算分子`}
                                      inputMode="numeric"
                                      value={conversions[field.fieldRef]?.numerator ?? ''}
                                      disabled={busy || readOnly}
                                      onChange={(event) =>
                                        setConversions((previous) => ({
                                          ...previous,
                                          [field.fieldRef]: {
                                            numerator: event.target.value,
                                            denominator: previous[field.fieldRef]?.denominator ?? '',
                                          },
                                        }))
                                      }
                                    />
                                  </label>
                                  <label>
                                    分母
                                    <input
                                      aria-label={`${field.label}换算分母`}
                                      inputMode="numeric"
                                      value={conversions[field.fieldRef]?.denominator ?? ''}
                                      disabled={busy || readOnly}
                                      onChange={(event) =>
                                        setConversions((previous) => ({
                                          ...previous,
                                          [field.fieldRef]: {
                                            numerator: previous[field.fieldRef]?.numerator ?? '',
                                            denominator: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                  </label>
                                </details>
                              </div>
                            )}
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
                      disabled={
                        busy ||
                        activeObject === undefined ||
                        preview?.confirmable !== true ||
                        previewRequest === undefined
                      }
                      onClick={() => void confirmMapping()}
                    >
                      确认映射
                    </button>
                  </div>
                )}

                {previewError === undefined ? null : (
                  <PublicStateNotice
                    testId="mapping-failure"
                    failure={classifyPublicError(previewError)}
                    onRecover={() => void previewMapping()}
                  />
                )}

                {preview === undefined ? null : (
                  <div data-testid="mapping-preview" data-confirmable={preview.confirmable}>
                    <p data-testid="mapping-preview-rows">数据行 {preview.rowCount}</p>
                    <ul data-testid="mapping-issues">
                      {preview.issues.map((mappingIssue: MappingIssue, index) => (
                        <li
                          key={`${mappingIssue.code}:${String(index)}`}
                          data-testid="mapping-issue"
                          data-code={mappingIssue.code}
                          data-severity={mappingIssue.severity}
                        >
                          {mappingIssue.code}：{mappingIssue.message}
                        </li>
                      ))}
                    </ul>
                    <table data-testid="mapping-preview-table">
                      <thead>
                        <tr>
                          <th>规范字段</th>
                          <th>原始值</th>
                          <th>规范值</th>
                          <th>实际定位</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.columns.map((column) => (
                          <tr
                            key={column.fieldRef}
                            data-testid={`mapping-preview-${column.fieldRef}`}
                            data-normalization={column.normalization}
                          >
                            <td>{column.fieldRef}</td>
                            <td>{column.samples[0]?.raw ?? '—'}</td>
                            <td>{column.samples[0]?.canonical ?? '—'}</td>
                            <td>{formatLocator(column.samples[0]?.locator)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p data-testid="mapping-preview-confirmable">
                      {preview.confirmable ? '可确认' : '存在阻断项，不可确认'}
                    </p>
                  </div>
                )}

                {confirmedMapping === undefined ? null : (
                  <p data-testid="mapping-confirmed" data-mapping-id={confirmedMapping.mappingId}>
                    映射已确认 · 版本 {confirmedMapping.version}
                  </p>
                )}
                {bindNotice === undefined ? null : <p data-testid="bind-notice">{bindNotice}</p>}
                {readOnly || confirmedMapping === undefined ? null : (
                  <button
                    type="button"
                    data-testid="record-bind"
                    disabled={busy}
                    onClick={() => void bindRecords()}
                  >
                    绑定记录
                  </button>
                )}
              </section>

              <section
                className="project-workspace__dataset"
                data-testid="project-dataset"
                hidden={step !== 'records'}
              >
                <h4>查询数据集</h4>
                <label className="project-workspace__field">
                  <span>记录类型</span>
                  <select
                    data-testid="dataset-object"
                    value={datasetObjectId}
                    disabled={busy}
                    onChange={(event) => setDatasetObjectId(event.target.value)}
                  >
                    <option value="">选择记录类型…</option>
                    {catalogue?.objects.map((object) => (
                      <option key={object.objectId} value={object.objectId}>
                        {object.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="dataset-status-refresh"
                  disabled={busy}
                  onClick={() => void refreshDataset()}
                >
                  查看状态
                </button>
                {readOnly ? null : (
                  <button
                    type="button"
                    data-testid="dataset-materialize"
                    disabled={
                      busy ||
                      (selected.activeRevision !== undefined &&
                        selected.activeRevision !== selected.headRevision)
                    }
                    onClick={() => void materialize()}
                  >
                    更新已确认查询数据
                  </button>
                )}
                {selected.activeRevision !== undefined &&
                selected.activeRevision !== selected.headRevision ? (
                  <p className="project-source-note">
                    先完成待发布修订的审核与切换，再更新该修订的查询数据。
                  </p>
                ) : null}
                {datasetStatus === undefined ? null : (
                  <p data-testid="dataset-status" data-state={datasetStatus.state}>
                    状态：{readinessStatusLabel(datasetStatus.state)}，完整性{' '}
                    {
                      { complete: '完整', partial: '部分', truncated: '已截断', unknown: '未知' }[
                        datasetStatus.completeness
                      ]
                    }
                    {datasetStatus.reason === undefined ? '' : `；${datasetStatus.reason}`}
                  </p>
                )}
              </section>

              <section
                className="project-workspace__records"
                data-testid="project-records"
                hidden={step !== 'records'}
              >
                <h4>项目记录</h4>
                <p data-testid="record-total">共 {recordTotal} 条</p>
                <ProjectFactStaging
                  client={client}
                  projectId={selected.projectId}
                  rows={records}
                  mappings={mappings}
                  {...(catalogue === undefined ? {} : { catalogue })}
                  readOnly={readOnly}
                  onReview={(recordId) => {
                    setReviewRecordId(recordId)
                    setReviewOwner(scope)
                    setReviewNonce((value) => value + 1)
                    setStep('review')
                  }}
                  onRefresh={() => {
                    void reloadCatalogue(selected.projectId)
                    void refreshRecords(selected.projectId).catch((caught: unknown) =>
                      setActionError(toError(caught)),
                    )
                  }}
                />
                {records.length === 0 ? (
                  <p data-testid="record-empty">当前页无记录。</p>
                ) : (
                  <table data-testid="record-table">
                    <thead>
                      <tr>
                        <th>记录</th>
                        <th>对象</th>
                        <th>状态</th>
                        <th>字段</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((record) => (
                        <tr
                          key={record.recordId}
                          data-testid="record-row"
                          data-record-id={record.recordId}
                          data-status={record.status}
                        >
                          <td>
                            {record.fields.find((field) => typeof field.raw === 'string')?.raw ?? '项目记录'}
                            <details className="project-audit">
                              <summary>记录标识</summary>
                              <code data-testid="record-id">{record.recordId}</code>
                            </details>
                          </td>
                          <td>{record.objectId}</td>
                          <td data-testid="record-status">{record.status}</td>
                          <td>
                            {record.fields.map((field) => (
                              <span
                                key={field.fieldId}
                                data-testid={`record-field-${field.fieldId}`}
                                data-status={field.status}
                              >
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
              {step !== 'review' ? null : (
                <InstanceReviewPanel
                  key={`${selected.projectId}:${reviewNonce}`}
                  client={client}
                  projectId={selected.projectId}
                  readOnly={readOnly}
                  {...(currentReviewRecordId === undefined ? {} : { initialRecordId: currentReviewRecordId })}
                />
              )}

              {actionError === undefined ? null : (
                <PublicStateNotice
                  testId="project-action-error"
                  failure={classifyPublicError(actionError)}
                  onRecover={() => {
                    if (selectedId !== undefined) void loadProjectData(selectedId)
                  }}
                />
              )}
            </div>
          )}
          {selected === undefined ? (
            <p className="project-canvas__body">选择一个项目，或创建项目后导入原始资料。</p>
          ) : null}
        </main>
      </div>
    </section>
  )
}
