import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isRecord, isRevisionString } from '@ontology/contracts'
import type { ActionDeclaration, AssetCandidateBatch, AssetCandidateVersion, AssetDraftVersion, DefinitionEditAdjudication, UnsupportedDefinitionRule, DefinitionCandidatePayload, DefinitionCompatibilityReport, RuleActionCandidateVersion, RuleExpressionNode, RuleExceptionNode } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import { definitionGuard } from '../../api/definitions'
import type { WorkspaceAuthoringContext, WorkspaceSourceView } from '../../api/workspace-authoring'
import type { GroundingView, HumanReviewView } from '../../api/ontology'
import { invalidWire, readGrounding, readHumanReviews } from '../../api/ontology'
import { editorAttributeChoices, editorObjectChoices, editorRelationChoices } from '../../api/semantic-authoring'
import { classifyPublicError } from '../../state/public-errors'
import type { PublicFailure } from '../../state/public-errors'
import { PublicStateNotice } from '../PublicStateNotice'
import { Button, Drawer, Field, StatusBadge, StateFeedback } from '../ui'
import { ConditionEditor, conditionSummary, clausePaths } from './ConditionEditor'
import { DefinitionEditor } from './DefinitionEditor'
import { humanClauseLabels, supportReasonLabels } from './labels'
import { ActionDeclarationEditor } from './ActionDeclarationEditor'
import { FullVersionDiff } from './FullVersionDiff'
import { SourceEvidencePane } from './SourceEvidencePane'
import './ontology.css'

const PANES = [{ key: 'list', label: '候选列表' }, { key: 'detail', label: '定义详情' }, { key: 'source', label: '原始依据' }] as const
type Pane = (typeof PANES)[number]['key']
type Candidate = AssetCandidateVersion | RuleActionCandidateVersion
function isDefinition(value: Candidate): value is AssetCandidateVersion { return value.kind === 'object' || value.kind === 'attribute' || value.kind === 'relation' }
function currentHeads<T extends { readonly candidateId: string; readonly replacesCandidateId?: string }>(values: readonly T[]): readonly T[] { const replaced = new Set(values.flatMap((v) => v.replacesCandidateId === undefined ? [] : [v.replacesCandidateId])); return values.filter((v) => !replaced.has(v.candidateId)) }
function pendingSource(value: Candidate): boolean { return isDefinition(value) ? value.pendingConfirmation : value.generationContext === undefined || value.generationContext.issues.some((i) => i.code === 'SOURCE_UNRESOLVED' || i.code === 'SOURCE_INCOMPLETE') }
interface EditBuffer { readonly payload: DefinitionCandidatePayload; readonly reason: string }
const labelKind: Readonly<Record<string, string>> = { object: '对象', attribute: '属性', relation: '关系', rule: '规则', action: '动作' }
const latestReview = (reviews: readonly HumanReviewView[]) => reviews.reduce<HumanReviewView | undefined>((latest, value) => latest === undefined || BigInt(value.revision) > BigInt(latest.revision) ? value : latest, undefined)
function candidateName(value: Candidate): string { return isDefinition(value) ? value.payload.displayName : value.displayName }
function candidateMeaning(value: Candidate): string { return isDefinition(value) ? value.payload.businessMeaning : value.businessMeaning }
function stateLabel(value: Candidate): string {
  if (pendingSource(value)) return '待确认来源'
  if (isDefinition(value)) return value.state === 'rejected' ? '已拒绝' : value.state === 'failed' ? '存在问题' : '待人工审核'
  return value.lifecycle === 'enabled' ? '已启用声明' : (value.payload.kind === 'rule' ? !value.payload.support.executable : !value.payload.binding?.executable) ? '暂不可执行' : '待人工审核'
}
function ruleOf(value: Candidate | undefined) { return value !== undefined && !isDefinition(value) && value.payload.kind === 'rule' ? value.payload : undefined }

export function OntologyReviewWorkbench({ client, workspaceId, readOnly = false }: { readonly client: WorkbenchClient; readonly workspaceId: string; readonly readOnly?: boolean }) {
  const [definitions, setDefinitions] = useState<readonly AssetCandidateVersion[]>([])
  const [rules, setRules] = useState<readonly RuleActionCandidateVersion[]>([])
  const [batches, setBatches] = useState<readonly AssetCandidateBatch[]>([])
  const [unsupported, setUnsupported] = useState<readonly UnsupportedDefinitionRule[]>([])
  const [adjudications, setAdjudications] = useState<readonly DefinitionEditAdjudication[]>([])
  const [draft, setDraft] = useState<AssetDraftVersion>()
  const [diff, setDiff] = useState<DefinitionCompatibilityReport>()
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [pane, setPane] = useState<Pane>('detail')
  const panelId = useId()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<PublicFailure>()
  const [notice, setNotice] = useState('')
  const [buffers, setBuffers] = useState<ReadonlyMap<string, EditBuffer>>(new Map())
  const [authoring, setAuthoring] = useState<WorkspaceAuthoringContext>()
  const [authoringFailure, setAuthoringFailure] = useState<PublicFailure>()
  const [actionDraft, setActionDraft] = useState<ActionDeclaration>()
  const [actionReason, setActionReason] = useState('')
  const [editing, setEditing] = useState(false)
  const [condition, setCondition] = useState<RuleExpressionNode>()
  const [exceptions, setExceptions] = useState<readonly RuleExceptionNode[]>([])
  const [ruleReason, setRuleReason] = useState('')
  const [grounding, setGrounding] = useState<GroundingView>()
  const [fragmentKey, setFragmentKey] = useState('')
  const [pathSelections, setPathSelections] = useState<Readonly<Record<string, string>>>({})
  const [sourceReason, setSourceReason] = useState('')
  const [reviews, setReviews] = useState<readonly HumanReviewView[]>([])
  const [reviewReadKey, setReviewReadKey] = useState('')
  const [reviewRefresh, setReviewRefresh] = useState(0)
  const [reviewReason, setReviewReason] = useState('')
  const [availableSources, setAvailableSources] = useState<readonly WorkspaceSourceView[]>([])
  const [sourceChoices, setSourceChoices] = useState<readonly string[]>([])
  const [sourceOpen, setSourceOpen] = useState(false)
  const [checked, setChecked] = useState<readonly string[]>([])
  const [operation, setOperation] = useState<'merge' | 'split' | 'keep_separate'>()
  const [mergeBaseId, setMergeBaseId] = useState('')
  const [operationReason, setOperationReason] = useState('')
  const [splitNames, setSplitNames] = useState('')
  const epoch = useRef(0)
  const currentWorkspace = useRef(workspaceId)
  currentWorkspace.current = workspaceId
  const actionAbort = useRef<AbortController | undefined>(undefined)
  const readAbort = useRef<AbortController | undefined>(undefined)
  const sourceAbort = useRef<AbortController | undefined>(undefined)
  const queueRef = useRef<HTMLUListElement>(null)
  const ruleBuffers = useRef(new Map<string, { condition: RuleExpressionNode; exceptions: readonly RuleExceptionNode[]; reason: string }>())
  const actionBuffers = useRef(new Map<string, { declaration: ActionDeclaration; reason: string }>())
  const retainedKeys = useRef(new Map<string, string>())
  const all = useMemo<readonly Candidate[]>(() => [...currentHeads(definitions), ...currentHeads(rules)], [definitions, rules])
  const selected = all.find((c) => c.candidateId === selectedId)
  const selectionKey = selected === undefined ? '' : `${workspaceId}:${selected.candidateId}:${selected.contentDigest}`
  const currentSelection = useRef(selectionKey); currentSelection.current = selectionKey
  const reviewLoaded = selected !== undefined && reviewReadKey === selectionKey
  const buffer = selected !== undefined && isDefinition(selected) ? buffers.get(`${workspaceId}:${selected.candidateId}:${selected.contentDigest}`) ?? { payload: selected.payload, reason: '' } : undefined
  const originalRule = ruleOf(selected)
  const unsaved = selected === undefined ? false : isDefinition(selected) ? buffer !== undefined && JSON.stringify(buffer.payload) !== JSON.stringify(selected.payload) : selected.payload.kind === 'rule' ? originalRule !== undefined && condition !== undefined && (JSON.stringify(condition) !== JSON.stringify(originalRule.condition) || JSON.stringify(exceptions) !== JSON.stringify(originalRule.exceptions)) : actionDraft !== undefined && JSON.stringify(actionDraft) !== JSON.stringify(selected.payload.declaration)
  const discardCurrentDraft = () => {
    if (selected === undefined) return
    const key = `${workspaceId}:${selected.candidateId}:${selected.contentDigest}`
    if (isDefinition(selected)) setBuffers((old) => { const next = new Map(old); next.delete(key); return next })
    else if (selected.payload.kind === 'rule') { ruleBuffers.current.delete(key); setCondition(selected.payload.condition); setExceptions(selected.payload.exceptions); setRuleReason('') }
    else { actionBuffers.current.delete(key); setActionDraft(selected.payload.declaration); setActionReason('') }
    setEditing(false)
  }
  const activeReview = latestReview(reviews.filter((review) => review.candidateId === selected?.candidateId))
  const reviewed = selected !== undefined && activeReview?.candidateId === selected.candidateId && activeReview.contentDigest === selected.contentDigest && activeReview.decision === 'approve'
  const inheritedProps = { ...(authoring?.definition === undefined ? {} : { inheritedDefinition: authoring.definition }), ...(authoring?.termLabels === undefined ? {} : { termLabels: authoring.termLabels }) }
  const labels = new Map([...editorObjectChoices(currentHeads(definitions), authoring?.definition).map((row) => [row.objectId, row.displayName] as const), ...editorAttributeChoices(currentHeads(definitions), authoring?.definition, authoring?.termLabels).map((row) => [row.attributeId, row.displayName] as const), ...editorRelationChoices(currentHeads(definitions), authoring?.definition, authoring?.termLabels).map((row) => [row.relationId, row.displayName] as const)])
  const visible = all.filter((c) => (filter === 'all' || filter === 'needs_source' && pendingSource(c) || c.kind === filter) && `${candidateName(c)} ${candidateMeaning(c)} ${c.logicalId}`.toLowerCase().includes(search.toLowerCase()))
  const load = useCallback(async (preferred?: string) => {
    const token = ++epoch.current
    setLoading(true)
    setFailure(undefined)
    try {
      const [ds, rs, drafts, batchList, unsupportedList, adjudicationList] = await Promise.all([client.listDefinitionCandidates(workspaceId, { limit: 250 }), client.listRuleActionCandidates(workspaceId, { limit: 250 }), client.listIndustryWorkspaceDrafts(workspaceId), client.listDefinitionGenerationBatches(workspaceId), client.listUnsupportedRules(workspaceId), client.listDefinitionAdjudications(workspaceId)])
      if (epoch.current !== token || currentWorkspace.current !== workspaceId) return
      const head = drafts.reduce<AssetDraftVersion | undefined>((a, b) => a === undefined || BigInt(b.revision) > BigInt(a.revision) ? b : a, undefined)
      setDefinitions(ds); setRules(rs); setDraft(head); setBatches(batchList); setUnsupported(unsupportedList); setAdjudications(adjudicationList)
      setSelectedId((old) => [...currentHeads(ds), ...currentHeads(rs)].some((c) => c.candidateId === (preferred ?? old)) ? preferred ?? old : currentHeads(ds)[0]?.candidateId ?? currentHeads(rs)[0]?.candidateId ?? '')
      if (head !== undefined) {
        const result = await client.getDefinitionCompatibility(workspaceId, head.revision)
        if (epoch.current === token) setDiff(result)
      } else setDiff(undefined)
    } catch (error) { if (epoch.current === token) setFailure(classifyPublicError(error)) }
    finally { if (epoch.current === token) setLoading(false) }
  }, [client, workspaceId])
  useEffect(() => {
    setDefinitions([]); setRules([]); setBatches([]); setUnsupported([]); setAdjudications([]); setDraft(undefined); setDiff(undefined); setSelectedId(''); setEditing(false); setChecked([]); setGrounding(undefined); setReviews([]); setNotice(''); setOperation(undefined); setBusy(false)
    void load()
    return () => { epoch.current++; readAbort.current?.abort(); sourceAbort.current?.abort(); actionAbort.current?.abort() }
  }, [load])
  useEffect(() => {
    readAbort.current?.abort(); sourceAbort.current?.abort()
    const controller = new AbortController(); readAbort.current = controller
    setGrounding(undefined); setFragmentKey(''); setPathSelections({}); setReviews([]); setReviewReadKey(''); setReviewReason(''); setSourceReason(''); setEditing(false)
    const rule = ruleOf(selected)
    const key = selected === undefined ? '' : `${workspaceId}:${selected.candidateId}:${selected.contentDigest}`
    const savedRule = ruleBuffers.current.get(key)
    setCondition(savedRule?.condition ?? rule?.condition); setExceptions(savedRule?.exceptions ?? rule?.exceptions ?? []); setRuleReason(savedRule?.reason ?? '')
    const savedAction = actionBuffers.current.get(key)
    setActionDraft(savedAction?.declaration ?? (selected?.payload.kind === 'action' ? selected.payload.declaration : undefined)); setActionReason(savedAction?.reason ?? '')
    if (selected === undefined) return () => controller.abort()
    const id = selected.candidateId
    void readHumanReviews(client, id, controller.signal).then((result) => { if (!controller.signal.aborted && currentSelection.current === key && currentWorkspace.current === workspaceId) { setReviews(result); setReviewReadKey(key) } }).catch((error: unknown) => { if (!controller.signal.aborted && currentSelection.current === key) setFailure(classifyPublicError(error)) })
    return () => controller.abort()
  }, [client, workspaceId, selected?.candidateId, selected?.contentDigest, reviewRefresh])
  useEffect(() => {
    if (draft === undefined) return undefined
    const abort = new AbortController(); setAuthoring(undefined); setAuthoringFailure(undefined)
    void client.getWorkspaceAuthoringContext(workspaceId, abort.signal).then((value) => { if (!abort.signal.aborted) { if (value.workspace.workspaceId !== workspaceId || value.draft.revision !== draft?.revision) return; setAuthoring(value) } }).catch((error: unknown) => { if (!abort.signal.aborted) setAuthoringFailure(classifyPublicError(error)) })
    return () => abort.abort()
  }, [client, workspaceId, draft?.revision])
  const bufferKey = selected === undefined ? '' : `${workspaceId}:${selected.candidateId}:${selected.contentDigest}`
  const changeRule = (nextCondition: RuleExpressionNode, nextExceptions = exceptions, nextReason = ruleReason) => { ruleBuffers.current.set(bufferKey, { condition: nextCondition, exceptions: nextExceptions, reason: nextReason }); setCondition(nextCondition); setExceptions(nextExceptions); setRuleReason(nextReason) }
  const changeAction = (declaration: ActionDeclaration, reason = actionReason) => { actionBuffers.current.set(bufferKey, { declaration, reason }); setActionDraft(declaration); setActionReason(reason) }
  const setBuffer = (next: EditBuffer) => { if (selected === undefined) return; const key = `${workspaceId}:${selected.candidateId}:${selected.contentDigest}`; setBuffers((old) => new Map(old).set(key, next)) }
  const write = async (path: string, body: unknown, onResult?: (result: unknown) => string | undefined, reviewRevision?: string) => {
    if (readOnly || busy || draft === undefined) return
    const token = epoch.current
    const target = workspaceId
    const controller = new AbortController(); actionAbort.current = controller
    const identity = `${target}:${path}:${reviewRevision ?? draft.revision}:${JSON.stringify(body)}`
    const key = retainedKeys.current.get(identity) ?? client.newRequestKey(); retainedKeys.current.set(identity, key)
    setBusy(true); setFailure(undefined); setNotice('')
    try {
      const result = await client.requestJson('POST', path, { body, ifMatch: reviewRevision ?? draft.revision, idempotencyKey: key, signal: controller.signal })
      if (currentWorkspace.current !== target || epoch.current !== token || controller.signal.aborted) return
      const next = onResult?.(result)
      if (path.endsWith('/reviews') && (!isRecord(result) || result['candidateId'] !== selected?.candidateId || result['contentDigest'] !== selected?.contentDigest || !isRevisionString(result['revision']))) return invalidWire()
      retainedKeys.current.delete(identity)
      setNotice('操作已由服务端确认。新的内容需要重新确认依据并单独审核。'); setEditing(false); setOperation(undefined)
      await load(next)
      if (currentWorkspace.current === target && !controller.signal.aborted) setReviewRefresh((value) => value + 1)
    } catch (error) {
      if (currentWorkspace.current !== target || epoch.current !== token) return
      if (controller.signal.aborted) setNotice('已停止等待；写入结果尚未确认。请刷新核对，草稿仍保留。')
      else setFailure(classifyPublicError(error))
    } finally { if (currentWorkspace.current === target && (epoch.current === token || !controller.signal.aborted)) setBusy(false) }
  }
  const prefix = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`
  const editedId = (value: unknown) => { if (!definitionGuard.definitionEditingResult(value)) return invalidWire(); return value.candidates[0]?.candidateId }
  const ruleId = (value: unknown) => { if (!isRecord(value) || !definitionGuard.ruleActionCandidateVersion(value['candidate'])) return invalidWire(); return value['candidate'].candidateId }
  const readSources = async () => {
    if (selected === undefined || draft === undefined) return
    const token = epoch.current; const controller = new AbortController(); sourceAbort.current?.abort(); sourceAbort.current = controller
    setFailure(undefined)
    try {
      const result = await client.getWorkspaceSources(workspaceId, controller.signal)
      if (controller.signal.aborted || token !== epoch.current) return
      if (result.draft.revision !== draft.revision || result.workspace.workspaceId !== workspaceId) return invalidWire()
      const original = isDefinition(selected) ? selected.sourceRefs : selected.generationContext?.inputSourceRefs ?? selected.sourceRefs
      setAvailableSources(result.sources); setSourceChoices(result.sources.filter((s) => original.some((ref) => ref.id === s.sourceRef.id && ref.version === s.sourceRef.version && ref.digest === s.sourceRef.digest)).map((s) => s.sourceRef.id)); setSourceOpen(true)
    } catch (error) { if (!controller.signal.aborted && token === epoch.current) setFailure(classifyPublicError(error)) }
  }
  const readChosenSources = async () => {
    if (selected === undefined || draft === undefined || sourceChoices.length === 0) return
    const token = epoch.current; const controller = new AbortController(); sourceAbort.current?.abort(); sourceAbort.current = controller
    setFailure(undefined); setGrounding(undefined); setFragmentKey(''); setPathSelections({})
    try {
      const sourceRefs = availableSources.filter((s) => sourceChoices.includes(s.sourceRef.id)).map((s) => s.sourceRef)
      const result = await readGrounding(client, workspaceId, sourceRefs, { ifMatch: draft.revision, signal: controller.signal })
      if (!controller.signal.aborted && token === epoch.current) { setGrounding(result); setPane('source') }
    } catch (error) { if (!controller.signal.aborted && token === epoch.current) setFailure(classifyPublicError(error)) }
  }
  const confirmSource = () => {
    if (selected === undefined || grounding === undefined || grounding.workspaceRevision !== draft?.revision || !sourceReason.trim()) return
    if (isDefinition(selected)) {
      const fragment = grounding.fragments.find((f) => `${f.sourceIndex}:${f.fragmentIndex}` === fragmentKey)
      if (fragment === undefined) return
      void write(`${prefix}/candidates/${selected.candidateId}/source-confirmations`, { contentDigest: selected.contentDigest, sourceRef: fragment.sourceRef, fragmentIndex: fragment.fragmentIndex, reason: sourceReason }, (v) => {
        if (!isRecord(v) || !Array.isArray(v['candidates']) || !v['candidates'].every(definitionGuard.assetCandidateVersion)) return invalidWire()
        return v['candidates'][0]?.candidateId
      })
    } else {
      const entries = Object.entries(pathSelections).map(([path, key]) => { const f = grounding.fragments.find((f) => `${f.sourceIndex}:${f.fragmentIndex}` === key); return f === undefined ? undefined : { path, sourceIndex: f.sourceIndex, fragmentIndex: f.fragmentIndex } })
      if (entries.some((v) => v === undefined)) return
      void write(`${prefix}/rule-action-candidates/${selected.candidateId}/source-confirmations`, { contentDigest: selected.contentDigest, sourceRefs: grounding.sources.map((source) => source.sourceRef), sourceSelections: entries, reason: sourceReason }, (v) => {
        if (!isRecord(v) || !Array.isArray(v['candidates']) || !v['candidates'].every(definitionGuard.ruleActionCandidateVersion)) return invalidWire()
        return v['candidates'][0]?.candidateId
      })
    }
  }
  const rule = ruleOf(selected)
  const paths = rule === undefined ? selected?.payload.kind === 'action' ? ['declaration', ...selected.payload.declaration.preconditions.map((_v, i) => `declaration.preconditions[${i}]`)] : [] : [...clausePaths(rule.condition), ...rule.exceptions.flatMap((v, i) => [`exceptions[${i}]`, ...clausePaths(v.condition, `exceptions[${i}].condition`)]), ...(rule.conclusion === undefined ? [] : ['conclusion']), ...(rule.dependencyRefs ?? []).map((_v, i) => `dependencyRefs[${i}]`), 'applicability']
  const clauseLabels = new Map<string, string>(rule === undefined ? [] : humanClauseLabels(rule.condition, labels))
  if (rule !== undefined) { rule.exceptions.forEach((exception, i) => { clauseLabels.set(`exceptions[${i}]`, `例外 ${i + 1} 的完整依据`); for (const [path, label] of humanClauseLabels(exception.condition, labels, `exceptions[${i}].condition`, `例外 ${i + 1}`)) clauseLabels.set(path, label) }); rule.dependencyRefs?.forEach((ref, i) => clauseLabels.set(`dependencyRefs[${i}]`, `上游规则：${labels.get(ref.ruleId) ?? ref.ruleId}`)); clauseLabels.set('conclusion', '业务结论'); clauseLabels.set('applicability', '规则适用范围') }
  clauseLabels.set('declaration', '动作声明整体依据'); if (selected?.payload.kind === 'action') selected.payload.declaration.preconditions.forEach((value, i) => clauseLabels.set(`declaration.preconditions[${i}]`, `动作前提 ${i + 1}：${value}`))
  const confirmReady = selected !== undefined && isDefinition(selected) ? fragmentKey !== '' : paths.length > 0 && paths.every((p) => pathSelections[p] !== undefined && pathSelections[p] !== '')
  const chosenDefinitions = definitions.filter((c) => checked.includes(c.candidateId))
  const referenced = definitions.filter((c) => selected !== undefined && (c.payload.kind === 'attribute' && c.payload.objectLogicalId === selected.logicalId || c.payload.kind === 'relation' && [c.payload.fromObjectLogicalId, c.payload.toObjectLogicalId].includes(selected.logicalId) || c.payload.kind === 'object' && c.payload.identityAttributeIds.includes(selected.logicalId)))
  return <section className="ontology-workbench" aria-label="本体审核工作台" data-testid="definition-workbench"><header className="ontology-workflow-head"><div><p className="ontology-eyebrow">本体工作区 · 第 3 步 / 5</p><h2>把业务含义与原始依据对齐</h2><p>选中一个候选，编辑定义、确认来源，再由人审核。</p></div><div className="ontology-actions"><Button disabled={busy || loading} onClick={() => void load()}>刷新当前版本</Button>{busy ? <Button onClick={() => actionAbort.current?.abort()}>停止等待</Button> : null}</div></header>
    <ol className="ontology-stepper" aria-label="工作流程"><li>1 资料准备</li><li>2 生成候选</li><li aria-current="step">3 编辑与审核</li><li>4 能力验核</li><li>5 版本发布</li></ol>
    {readOnly ? <p role="status" className="ontology-notice">当前为只读角色，可查看定义、原始依据和审核记录。</p> : null}
    {failure === undefined ? null : <PublicStateNotice failure={failure} onRecover={() => void load()} />}{notice ? <p role="status" className="ontology-notice">{notice}</p> : null}
    {loading && all.length === 0 ? <StateFeedback title="正在读取候选" description="读取当前工作区的真实草稿与候选版本。" tone="loading" /> : <>
    <div className="ontology-mobile-tabs" role="tablist" aria-label="工作区面板" onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = PANES.findIndex((item) => item.key === pane); const next = event.key === 'Home' ? PANES[0] : event.key === 'End' ? PANES[2] : PANES[(current + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; if (next !== undefined) { setPane(next.key); event.currentTarget.querySelector<HTMLButtonElement>(`[data-ontology-pane="${next.key}"]`)?.focus() } }}>{PANES.map(({ key, label }) => <Button key={key} id={`${panelId}-tab-${key}`} data-ontology-pane={key} role="tab" aria-controls={`${panelId}-pane-${key}`} tabIndex={pane === key ? 0 : -1} aria-selected={pane === key} onClick={() => setPane(key)}>{label}</Button>)}</div>
    <div className="ontology-three-pane" data-pane={pane}><aside className="ontology-queue" id={`${panelId}-pane-list`} role="tabpanel" aria-labelledby={`${panelId}-tab-list`}><h3>待处理候选</h3><Field label="搜索业务名称或含义">{(a) => <input {...a} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field><Field label="筛选类别">{(a) => <select {...a} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部</option><option value="needs_source">待确认来源</option>{Object.entries(labelKind).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}</Field>
      <p className="ontology-hint">当前页 {visible.length} 项；每类最多读取 250 项，超出时请按类别缩小范围。</p><ul ref={queueRef} className="ontology-candidate-list" onKeyDown={(event) => { if (!(["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) || busy || visible.length === 0 || event.target instanceof HTMLInputElement) return; event.preventDefault(); const index = visible.findIndex((c) => c.candidateId === selectedId); const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))); const candidate = visible[next]; if (candidate !== undefined) { setSelectedId(candidate.candidateId); queueRef.current?.querySelector<HTMLButtonElement>(`[data-candidate-id="${candidate.candidateId}"] button`)?.focus() } }}>{visible.map((c) => <li key={c.candidateId} data-testid={isDefinition(c) ? "definition-candidate" : "rule-action-candidate"} data-candidate-id={c.candidateId} data-kind={c.kind} data-state={isDefinition(c) ? c.state : c.lifecycle} className={c.candidateId === selectedId ? 'is-selected' : ''}>{!readOnly && isDefinition(c) ? <input aria-label={`批量选择${candidateName(c)}`} type="checkbox" checked={checked.includes(c.candidateId)} onChange={(e) => setChecked((old) => e.target.checked ? [...old, c.candidateId] : old.filter((id) => id !== c.candidateId))} /> : null}<button type="button" disabled={busy} aria-pressed={c.candidateId === selectedId} onClick={() => { setSelectedId(c.candidateId); setPane('detail') }}><span>{labelKind[c.kind]} · {candidateName(c)}</span><small>{stateLabel(c)}</small><p>{candidateMeaning(c)}</p></button></li>)}</ul>{visible.length === 0 ? <p role="status">没有符合条件的候选。可调整筛选，或先在资料步骤生成候选。</p> : null}
      {!readOnly && checked.length >= 2 ? <div className="ontology-actions"><Button onClick={() => setOperation('merge')}>合并所选</Button><Button onClick={() => setOperation('keep_separate')}>保留独立</Button></div> : null}
    </aside><section className="ontology-detail" id={`${panelId}-pane-detail`} role="tabpanel" aria-labelledby={`${panelId}-tab-detail`}>{selected === undefined ? <StateFeedback title="还没有候选" description="先上传并确认资料，再生成定义、规则或动作候选。" /> : <>
      <header className="ontology-pane-heading"><div><p className="ontology-eyebrow">{labelKind[selected.kind]}</p><h3>{candidateName(selected)}</h3></div><StatusBadge tone={pendingSource(selected) ? 'warning' : reviewed ? 'success' : 'neutral'}>{reviewed ? '当前内容已人工批准' : stateLabel(selected)}</StatusBadge></header><p className="ontology-business-meaning">{candidateMeaning(selected)}</p>
      {(isDefinition(selected) ? selected.inputDraftRef.revision : selected.generationContext?.inputDraftRef.revision) !== draft?.revision ? <p className="ontology-notice">此候选产生于较早的工作区版本。修改与审核会由服务端重新检查当前边界。</p> : null}
      {isDefinition(selected) ? <><dl className="ontology-terms"><dt>业务建议</dt><dd>{selected.payload.suggestedReason}</dd>{selected.payload.kind === 'object' ? <><dt>身份范围</dt><dd>{selected.payload.identityScopeDimensions?.includes('project') ? '当前项目内区分身份' : '未声明项目身份分区'}；身份属性：{selected.payload.identityAttributeIds.map((id) => labels.get(id) ?? id).join('、') || '未声明'}</dd></> : <><dt>值数量</dt><dd>{selected.payload.minCardinality} 至 {selected.payload.maxCardinality === 'unbounded' ? '不限' : selected.payload.maxCardinality}</dd></>}</dl>{selected.payload.conflicts.map((c, i) => <p role="status" className="ontology-notice" key={i}>{c.message}</p>)}{selected.issues.map((issue, i) => <p className="ontology-notice" key={i}>{issue.message}</p>)}
        {!readOnly ? <div className="ontology-actions"><Button disabled={busy} onClick={() => setEditing((old) => !old)}>{editing ? '收起编辑（保留草稿）' : '编辑定义'}</Button><Button disabled={busy} onClick={() => setOperation('split')}>拆分定义</Button></div> : null}
        {editing && buffer !== undefined ? <DefinitionEditor value={buffer.payload} onChange={(payload) => setBuffer({ ...buffer, payload })} candidates={currentHeads(definitions)} {...inheritedProps} disabled={busy} reason={buffer.reason} onReason={(reason) => setBuffer({ ...buffer, reason })} onSave={() => void write(`${prefix}/candidates/${selected.candidateId}/edits`, { payload: buffer.payload, reason: buffer.reason }, editedId)} /> : null}
      </> : rule !== undefined ? <><StatusBadge tone={rule.support.executable ? 'success' : 'warning'}>{rule.support.executable ? '有限条件可执行' : '暂不可执行'}</StatusBadge><h4>满足什么条件</h4><p className="ontology-rule-summary">{conditionSummary(rule.condition, labels)}</p><h4>例外</h4>{rule.exceptions.length === 0 ? <p>没有声明例外。</p> : <ul>{rule.exceptions.map((e) => <li key={e.exceptionId}>{conditionSummary(e.condition, labels)}</li>)}</ul>}<p>适用对象：{labels.get(rule.applicability.objectId) ?? rule.applicability.objectId} · {rule.applicability.note ?? '未补充适用说明'}</p><p>上游规则：{rule.ruleDependencies.join('、') || '无'}</p>{rule.support.findings.map((f, i) => <div key={i} className="ontology-notice">{supportReasonLabels[f.code] ?? f.message}<details><summary>详细原因</summary><p>{f.code} · {f.message}</p></details></div>)}
        {!readOnly ? <Button disabled={busy} onClick={() => setEditing((old) => !old)}>{editing ? '收起编辑' : '编辑规则条件与例外'}</Button> : null}{editing && condition !== undefined ? <div><ConditionEditor value={condition} onChange={(value) => changeRule(value)} definitions={currentHeads(definitions)} {...inheritedProps} objectId={rule.applicability.objectId} disabled={busy} />{exceptions.map((exception, i) => <div key={exception.exceptionId}><h4>例外 {i + 1}</h4><ConditionEditor value={exception.condition} onChange={(node) => changeRule(condition, exceptions.map((v, j) => j === i ? { ...v, condition: node } : v))} definitions={currentHeads(definitions)} {...inheritedProps} objectId={rule.applicability.objectId} disabled={busy} relationAllowed={false} /><Button onClick={() => changeRule(condition, exceptions.filter((_v, j) => j !== i))}>移除此例外</Button></div>)}<Button disabled={exceptions.length >= 4} onClick={() => changeRule(condition, [...exceptions, { exceptionId: `exception-${client.newRequestKey()}`, condition: { op: 'compare', attributeId: '', operator: 'eq', value: '', spans: [] }, spans: [] }])}>添加例外</Button><Field label="修改原因">{(a) => <textarea {...a} value={ruleReason} onChange={(e) => changeRule(condition, exceptions, e.target.value)} />}</Field><Button variant="primary" disabled={busy || !ruleReason.trim()} onClick={() => void write(`${prefix}/rule-action-candidates/${selected.candidateId}/edits`, { rule: { ruleId: rule.ruleId, displayName: selected.displayName, businessMeaning: selected.businessMeaning, suggestedReason: selected.suggestedReason, objectId: rule.applicability.objectId, ...(rule.applicability.note === undefined ? {} : { applicabilityNote: rule.applicability.note }), condition, exceptions, ...(rule.conclusion === undefined ? {} : { conclusion: rule.conclusion }), ruleDependencies: rule.ruleDependencies, dependencyRefs: rule.dependencyRefs }, reason: ruleReason, sourceRefs: selected.sourceRefs }, ruleId)}>保存为新规则候选</Button></div> : null}
      </> : selected.payload.kind === 'action' ? <><h4>动作声明</h4><p>作用：{selected.payload.declaration.sideEffect === 'none' || selected.payload.declaration.sideEffect === 'read_only' ? '只读' : '可能产生业务变更'}</p><p>所需权限：{selected.payload.declaration.permissions.join('、') || '未声明'}</p><p>所需能力：{selected.payload.declaration.requiredCapabilities.map((c) => c.name).join('、') || '未声明'}</p><p>绑定状态：{selected.payload.binding?.executable ? '已绑定可执行实现' : '尚未绑定可执行实现'}。动作启用与实际部署执行分别验核。</p>{(selected.payload.binding?.findings ?? []).map((f, i) => <div key={i} className="ontology-notice">{supportReasonLabels[f.code] ?? f.message}<details><summary>详细原因</summary><p>{f.code} · {f.message}</p></details></div>)}{authoringFailure === undefined ? null : <PublicStateNotice failure={authoringFailure} />}{!readOnly ? <Button disabled={busy || authoring === undefined} onClick={() => setEditing((old) => !old)}>编辑动作与注册绑定</Button> : null}{editing && actionDraft !== undefined && authoring !== undefined ? <ActionDeclarationEditor value={actionDraft} onChange={(value) => changeAction(value)} operations={authoring.operations} disabled={busy} reason={actionReason} onReason={(reason) => changeAction(actionDraft, reason)} onSave={() => void write(`${prefix}/rule-action-candidates/${selected.candidateId}/edits`, { action: actionDraft, reason: actionReason, sourceRefs: selected.sourceRefs }, ruleId)} /> : null}<p className="ontology-notice">动作只能选择当前环境授权的注册实现；目录尚未读取时不能填写任意地址、代码或凭据。</p></> : null}
      <section className="ontology-review-bar"><h4>确认依据与人工审核</h4>{unsaved ? <div className="ontology-notice"><p>还有未保存的编辑。先保存为新候选并重新确认来源，才能审核这些新内容。</p>{!readOnly ? <Button disabled={busy} onClick={discardCurrentDraft}>放弃当前未保存编辑</Button> : null}</div> : null}<Button disabled={busy} onClick={() => void readSources()}>查看原始资料与定位片段</Button>{pendingSource(selected) ? <p>此版本尚未确认真实来源，不能把“保存”视作批准。</p> : <p>来源状态已由服务端记录；人工批准仅针对当前内容。</p>}{activeReview === undefined ? <p>{reviewLoaded ? '当前候选还没有人工审核记录。' : '正在读取当前内容的审核记录…'}</p> : <p>{reviewed ? '当前内容已批准' : '当前内容尚未批准'} · {activeReview.reason}</p>}
        {!readOnly ? <><Field label="审核意见">{(a) => <textarea {...a} value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} />}</Field><div className="ontology-actions"><Button variant="primary" disabled={busy || unsaved || !reviewLoaded || pendingSource(selected) || (isDefinition(selected) ? selected.state === 'failed' || selected.state === 'rejected' : selected.lifecycle === 'rejected') || !reviewReason.trim()} onClick={() => void write(`/api/v1/candidates/${selected.candidateId}/reviews`, { decision: 'approve', reason: reviewReason }, undefined, activeReview?.revision ?? '0')}>批准当前内容</Button><Button disabled={busy || !reviewLoaded || !reviewReason.trim()} onClick={() => void write(`/api/v1/candidates/${selected.candidateId}/reviews`, { decision: 'reject', reason: reviewReason }, undefined, activeReview?.revision ?? '0')}>拒绝当前内容</Button>{isDefinition(selected) ? <Button variant="danger" disabled={busy || !reviewReason.trim()} onClick={() => void write(`${prefix}/candidates/${selected.candidateId}/rejections`, { reason: reviewReason }, editedId)}>撤销此定义候选</Button> : null}{!isDefinition(selected) ? <Button disabled={busy || unsaved || !reviewed || pendingSource(selected) || selected.lifecycle === 'enabled' || (selected.payload.kind === 'rule' ? !selected.payload.support.executable : !selected.payload.binding?.executable)} onClick={() => void write(`${prefix}/rule-action-candidates/${selected.candidateId}/enable`, {}, ruleId)}>启用通过验核的声明</Button> : null}</div></> : null}
      </section><details className="ontology-advanced"><summary>高级：版本、来源固定点与原始结构</summary><pre>{JSON.stringify({ candidateId: selected.candidateId, contentDigest: selected.contentDigest, inputDraftRef: isDefinition(selected) ? selected.inputDraftRef : selected.generationContext?.inputDraftRef, sourceRefs: selected.sourceRefs, sourceSpans: selected.sourceSpans, payload: selected.payload }, null, 2)}</pre></details>
    </>}</section><aside className="ontology-evidence" id={`${panelId}-pane-source`} role="tabpanel" aria-labelledby={`${panelId}-tab-source`}><SourceEvidencePane value={grounding} selected={fragmentKey} onSelect={setFragmentKey} /></aside></div>
    </>}
    <Drawer open={sourceOpen} title="原始依据与来源确认" onClose={() => setSourceOpen(false)}><fieldset disabled={busy}><legend>选择当前语料中的真实资料</legend>{availableSources.map((source, i) => <label className="ontology-source-choice" key={source.sourceRef.id}><input type="checkbox" checked={sourceChoices.includes(source.sourceRef.id)} onChange={(e) => { setSourceChoices((old) => e.target.checked ? [...old, source.sourceRef.id] : old.filter((id) => id !== source.sourceRef.id)); setGrounding(undefined); setPathSelections({}); setFragmentKey('') }} />{source.name ?? `资料 ${i + 1}`}</label>)}<Button disabled={sourceChoices.length === 0} onClick={() => void readChosenSources()}>读取所选原文与真实片段</Button></fieldset><SourceEvidencePane value={grounding} selected={fragmentKey} onSelect={setFragmentKey} />{!readOnly && selected !== undefined && grounding !== undefined ? <div>{!isDefinition(selected) ? <div><h3>为每个条件选择真实依据</h3>{paths.map((path) => <Field key={path} label={clauseLabels.get(path) ?? "声明来源"} hint="为这项业务含义选择刚刚读取的真实片段。">{(a) => <select {...a} value={pathSelections[path] ?? ''} onChange={(e) => setPathSelections((old) => ({ ...old, [path]: e.target.value }))}><option value="">选择片段</option>{grounding.fragments.map((f) => <option key={`${f.sourceIndex}:${f.fragmentIndex}`} value={`${f.sourceIndex}:${f.fragmentIndex}`}>资料 {f.sourceIndex + 1} · 片段 {f.fragmentIndex + 1} · {f.text.slice(0, 50)}</option>)}</select>}</Field>)}</div> : null}<Field label="来源确认说明">{(a) => <textarea {...a} value={sourceReason} onChange={(e) => setSourceReason(e.target.value)} />}</Field><Button variant="primary" disabled={busy || !confirmReady || !sourceReason.trim() || grounding.coverage !== 'complete' || grounding.workspaceRevision !== draft?.revision} onClick={confirmSource}>确认依据并生成新候选</Button><p>确认后新候选仍需单独人工审核。未读取、表头或失效片段不能代替实际来源。</p></div> : null}</Drawer>
    <Drawer open={operation !== undefined} title={operation === 'merge' ? '预览合并影响' : operation === 'split' ? '预览拆分影响' : '保留独立含义'} onClose={() => setOperation(undefined)}><p>所选：{(operation === 'split' && selected !== undefined ? [selected] : chosenDefinitions).map(candidateName).join('、')}</p><p>当前已读取的关联定义：{referenced.map((c) => c.payload.displayName).join('、') || '未发现'}。服务端会检查完整引用并返回实际影响与阻断。</p>{operation === 'split' ? <Field label="拆分后的名称" hint="每行一个，至少两个；每个新定义保存后仍需核对结构、确认来源与审核。">{(a) => <textarea {...a} value={splitNames} onChange={(e) => setSplitNames(e.target.value)} />}</Field> : null}{operation === 'merge' ? <Field label="合并后保留哪一个结构" hint="显式选择主定义；不会把另一项的单位、身份范围或关系端点自动拼接进去。">{(a) => <select {...a} value={mergeBaseId} onChange={(e) => setMergeBaseId(e.target.value)}><option value="">选择主定义并核对下方结构</option>{chosenDefinitions.map((value) => <option key={value.candidateId} value={value.candidateId}>{value.payload.displayName} · {value.payload.businessMeaning}</option>)}</select>}</Field> : null}<Field label="操作原因">{(a) => <textarea {...a} value={operationReason} onChange={(e) => setOperationReason(e.target.value)} />}</Field><Button variant="primary" disabled={busy || !operationReason.trim() || operation === 'merge' && !mergeBaseId || operation === 'split' && splitNames.split('\n').filter((v) => v.trim()).length < 2} onClick={() => {
      if (operation === 'split' && selected !== undefined && isDefinition(selected)) { const names = splitNames.split('\n').map((s) => s.trim()).filter(Boolean); if (names.length < 2) return; void write(`${prefix}/candidates/${selected.candidateId}/splits`, { parts: names.map((displayName, i) => ({ ...selected.payload, displayName, logicalId: `${selected.logicalId}_split_${i + 1}` })), reason: operationReason }, editedId) }
      else if (operation === 'merge') { const base = chosenDefinitions.find((value) => value.candidateId === mergeBaseId); if (base === undefined || chosenDefinitions.length < 2 || chosenDefinitions.some((c) => c.kind !== base.kind)) return; void write(`${prefix}/candidate-merges`, { candidateIds: checked, mergedPayload: base.payload, reason: operationReason }, editedId) }
      else if (operation === 'keep_separate') void write(`${prefix}/candidate-decisions/keep-separate`, { candidateIds: checked, reason: operationReason }, editedId)
    }}>确认并生成新版本</Button><details><summary>查看完整操作前结构</summary><pre>{JSON.stringify((operation === 'split' && selected !== undefined ? [selected] : chosenDefinitions).map((c) => c.payload), null, 2)}</pre></details></Drawer>
    <section className="ontology-lifecycle"><h3>生成与变更记录</h3>{batches.length === 0 ? <p>尚无已记录的生成批次。</p> : batches.map((batch) => <article key={batch.batchId}><p>实际产生 {batch.counts.total} 个候选 · 待来源确认 {batch.counts.pendingConfirmation} · 失败 {batch.counts.failed}</p>{batch.error === undefined ? null : <p className="ontology-notice">{batch.error.message}</p>}<details><summary>批次版本与调用信息</summary><pre>{JSON.stringify(batch, null, 2)}</pre></details></article>)}
      {unsupported.length === 0 ? null : <section><h4>保留的不可执行规则</h4>{unsupported.map((value) => <article key={value.ruleId}><StatusBadge tone="warning">暂不可执行</StatusBadge><p>{value.reason}</p><details><summary>完整原始规则</summary><pre>{JSON.stringify(value, null, 2)}</pre></details></article>)}</section>}
      <section><h4>服务端记录的实际编辑影响</h4>{adjudications.map((adjudication) => <article key={adjudication.adjudicationId}><p>{adjudication.reason}</p><ul>{adjudication.affected.map((affected, i) => <li key={i}>{labels.get(affected.logicalId) ?? affected.logicalId}：{affected.impact}</li>)}</ul>{adjudication.findings.map((finding, i) => <p key={i} className="ontology-notice">{finding.message}</p>)}<details><summary>完整裁决与版本信息</summary><pre>{JSON.stringify(adjudication, null, 2)}</pre></details></article>)}</section>
    </section>{diff === undefined ? <p>尚未取得当前版本的差异。</p> : <FullVersionDiff changes={[...diff.additions, ...diff.changes]} labels={labels} />}
    <details className="ontology-advanced"><summary>差异完整版本与阻断详情</summary><pre>{JSON.stringify(diff, null, 2)}</pre></details>
  </section>
}
