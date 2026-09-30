import { useCallback, useEffect, useState } from 'react'
import type {
  AssetCandidateBatch,
  AssetCandidateVersion,
  AssetDraftVersion,
  DefinitionCandidatePayload,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionValidationReport,
  IndustryAttributeValueType,
  RuleActionCandidateVersion,
  UnsupportedDefinitionRule,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type { ActionCandidateDraft, RuleCandidateDraft } from '../api/definitions'
import { StatePanel } from './StatePanel'
import { PublicStateNotice } from './PublicStateNotice'
import { classifyPublicError } from '../state/public-errors'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'

/**
 * The public definition / rule / action review workbench (V03-012 / #185, SPEC v0.3a §9.2,
 * A.US-003, P.US-004/005/006/007).
 *
 * It lists the definition (object/attribute/relation) candidates with their source, conflicts and
 * generation-vs-draft drift, the rule candidates with their preserved condition, exceptions,
 * applicability and support state, and the action declarations with their capability binding.
 * Editing, rejecting, merging terminology, revising a rule and recording an unsupported rule all
 * call the real management endpoints over If-Match/CAS, so a stale head is refused instead of
 * silently overwritten. A rule outside the executable subset or an unbound/incompatible action is
 * shown with its classified reason and cannot be enabled.
 *
 * The panel is generic: it never names an industry and it mounts no professional view. Scenario UI
 * stays behind the V03-022 mount registry; this panel is injected as the public home.
 */

export interface DefinitionWorkbenchPanelProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  readonly readOnly?: boolean
}

export interface DefinitionEditFields {
  displayName: string
  businessMeaning: string
  suggestedReason: string
  valueType: string
  unitCode: string
  fromObjectLogicalId: string
  toObjectLogicalId: string
  identityAttributeIds: string
  reason: string
}

const VALUE_TYPES: readonly IndustryAttributeValueType[] = [
  'string',
  'number',
  'boolean',
  'timestamp',
  'enum',
  'quantity',
  'reference',
]

function isValueType(value: string): value is IndustryAttributeValueType {
  return (VALUE_TYPES as readonly string[]).includes(value)
}

const EMPTY_EDIT_FIELDS: DefinitionEditFields = {
  displayName: '',
  businessMeaning: '',
  suggestedReason: '',
  valueType: 'string',
  unitCode: '',
  fromObjectLogicalId: '',
  toObjectLogicalId: '',
  identityAttributeIds: '',
  reason: '',
}

export function editFieldsOf(candidate: AssetCandidateVersion): DefinitionEditFields {
  const payload = candidate.payload
  return {
    displayName: payload.displayName,
    businessMeaning: payload.businessMeaning,
    suggestedReason: payload.suggestedReason,
    valueType: payload.kind === 'attribute' ? payload.valueType : 'string',
    unitCode: payload.kind === 'attribute' ? (payload.unitCode ?? '') : '',
    fromObjectLogicalId: payload.kind === 'relation' ? payload.fromObjectLogicalId : '',
    toObjectLogicalId: payload.kind === 'relation' ? payload.toObjectLogicalId : '',
    identityAttributeIds: payload.kind === 'object' ? payload.identityAttributeIds.join(', ') : '',
    reason: '',
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Apply the human edit to the existing candidate payload. The `kind` and every field the form does
 * not touch are preserved, so an edit can never loosen an unrelated type, unit or cardinality.
 */
export function buildEditedPayload(
  payload: DefinitionCandidatePayload,
  fields: DefinitionEditFields,
): DefinitionCandidatePayload {
  const displayName = fields.displayName.trim().length === 0 ? payload.displayName : fields.displayName.trim()
  const businessMeaning = fields.businessMeaning.trim()
  const suggestedReason = fields.suggestedReason.trim()
  const common = {
    logicalId: payload.logicalId,
    displayName,
    businessMeaning: businessMeaning.length === 0 ? payload.businessMeaning : businessMeaning,
    suggestedReason: suggestedReason.length === 0 ? payload.suggestedReason : suggestedReason,
  }
  if (payload.kind === 'object') {
    const identityAttributeIds = splitList(fields.identityAttributeIds)
    return {
      ...payload,
      ...common,
      identityAttributeIds: identityAttributeIds.length === 0 ? payload.identityAttributeIds : identityAttributeIds,
    }
  }
  if (payload.kind === 'attribute') {
    const valueType: IndustryAttributeValueType = isValueType(fields.valueType) ? fields.valueType : payload.valueType
    const unitCode = fields.unitCode.trim()
    return {
      ...payload,
      ...common,
      valueType,
      ...(unitCode.length === 0
        ? payload.unitCode === undefined
          ? {}
          : { unitCode: payload.unitCode }
        : { unitCode }),
    }
  }
  return {
    ...payload,
    ...common,
    fromObjectLogicalId:
      fields.fromObjectLogicalId.trim().length === 0 ? payload.fromObjectLogicalId : fields.fromObjectLogicalId.trim(),
    toObjectLogicalId:
      fields.toObjectLogicalId.trim().length === 0 ? payload.toObjectLogicalId : fields.toObjectLogicalId.trim(),
  }
}

export type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

export function parseJsonText(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON 解析失败' }
  }
}

export function candidateSourceLabel(candidate: AssetCandidateVersion): string {
  if (candidate.sourceRefs.length === 0) return '无来源定位'
  const first = candidate.sourceRefs[0]
  return first === undefined ? '无来源定位' : `${candidate.sourceRefs.length} 项（${first.id.slice(0, 8)}…）`
}

export function isCandidateStale(candidate: AssetCandidateVersion, headRevision: string | undefined): boolean {
  return headRevision !== undefined && candidate.inputDraftRef.revision !== headRevision
}

/** The kind-specific contract a reviewer checks before editing: type/unit, endpoints or identity. */
export function candidateDetailLabel(payload: DefinitionCandidatePayload): string {
  if (payload.kind === 'object') {
    return `身份属性：${payload.identityAttributeIds.length === 0 ? '（未声明）' : payload.identityAttributeIds.join('、')}`
  }
  if (payload.kind === 'attribute') {
    const max = payload.maxCardinality === 'unbounded' ? '*' : String(payload.maxCardinality)
    const unit = payload.unitCode === undefined ? '（无单位）' : payload.unitCode
    return `类型：${payload.valueType} · 单位：${unit} · 基数：${String(payload.minCardinality)}..${max}`
  }
  const max = payload.maxCardinality === 'unbounded' ? '*' : String(payload.maxCardinality)
  return `端点：${payload.fromObjectLogicalId} → ${payload.toObjectLogicalId} · 基数：${String(payload.minCardinality)}..${max}`
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
  return { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '请求无法完成。', retryable: true }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError && error.permissionDenied) return 'permission_denied'
  return 'failure'
}

export function DefinitionWorkbenchPanel({ client, workspaceId, readOnly = false }: DefinitionWorkbenchPanelProps) {
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<WorkbenchError | undefined>(undefined)

  const [drafts, setDrafts] = useState<readonly AssetDraftVersion[]>([])
  const [headRevision, setHeadRevision] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly AssetCandidateVersion[]>([])
  const [batches, setBatches] = useState<readonly AssetCandidateBatch[]>([])
  const [ruleActions, setRuleActions] = useState<readonly RuleActionCandidateVersion[]>([])
  const [unsupported, setUnsupported] = useState<readonly UnsupportedDefinitionRule[]>([])
  const [adjudications, setAdjudications] = useState<readonly DefinitionEditAdjudication[]>([])
  const [compatibility, setCompatibility] = useState<DefinitionCompatibilityReport | undefined>(undefined)
  const [validation, setValidation] = useState<DefinitionValidationReport | undefined>(undefined)

  const [editingDefinitionId, setEditingDefinitionId] = useState<string | undefined>(undefined)
  const [editFields, setEditFields] = useState<DefinitionEditFields>(EMPTY_EDIT_FIELDS)
  const [rejectingDefinitionId, setRejectingDefinitionId] = useState<string | undefined>(undefined)
  const [rejectReason, setRejectReason] = useState('')
  const [mergeSelection, setMergeSelection] = useState<readonly string[]>([])
  const [mergeName, setMergeName] = useState('')
  const [mergeReason, setMergeReason] = useState('')

  const [editingRuleId, setEditingRuleId] = useState<string | undefined>(undefined)
  const [ruleCondition, setRuleCondition] = useState('')
  const [ruleExceptions, setRuleExceptions] = useState('[]')
  const [ruleConclusion, setRuleConclusion] = useState('')
  const [ruleReason, setRuleReason] = useState('')
  const [ruleEditError, setRuleEditError] = useState<string | undefined>(undefined)

  const [editingActionId, setEditingActionId] = useState<string | undefined>(undefined)
  const [actionDeclaration, setActionDeclaration] = useState('')
  const [actionReason, setActionReason] = useState('')
  const [actionEditError, setActionEditError] = useState<string | undefined>(undefined)

  const [unsupportedRuleId, setUnsupportedRuleId] = useState('')
  const [unsupportedReason, setUnsupportedReason] = useState('')
  const [unsupportedRaw, setUnsupportedRaw] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const [draftList, candidateList, batchList, ruleActionList, unsupportedList, adjudicationList] = await Promise.all([
        client.listIndustryWorkspaceDrafts(workspaceId),
        client.listDefinitionCandidates(workspaceId),
        client.listDefinitionGenerationBatches(workspaceId),
        client.listRuleActionCandidates(workspaceId),
        client.listUnsupportedRules(workspaceId),
        client.listDefinitionAdjudications(workspaceId),
      ])
      setDrafts(draftList)
      setCandidates(candidateList)
      setBatches(batchList)
      setRuleActions(ruleActionList)
      setUnsupported(unsupportedList)
      setAdjudications(adjudicationList)
      const head = draftList[draftList.length - 1]
      setHeadRevision(head?.revision)
      if (head !== undefined) {
        const [diff, report] = await Promise.all([
          client.getDefinitionCompatibility(workspaceId, head.revision),
          client.validateDefinitions(workspaceId, { revision: head.revision }),
        ])
        setCompatibility(diff)
        setValidation(report)
      } else {
        setCompatibility(undefined)
        setValidation(undefined)
      }
      setPhase(candidateList.length === 0 && ruleActionList.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      setBusy(true)
      setActionError(undefined)
      try {
        await operation()
        await load()
      } catch (caught) {
        setActionError(toError(caught))
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const requireRevision = (): string | undefined => {
    if (headRevision === undefined) {
      setActionError({ code: 'REVISION_REQUIRED', message: '工作区没有可编辑的草稿修订。' })
      return undefined
    }
    return headRevision
  }

  const startEditDefinition = (candidate: AssetCandidateVersion): void => {
    setEditingDefinitionId(candidate.candidateId)
    setEditFields(editFieldsOf(candidate))
    setActionError(undefined)
  }

  const submitDefinitionEdit = (candidate: AssetCandidateVersion): void => {
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    if (editFields.reason.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写修改原因。' })
      return
    }
    void run(async () => {
      await client.editDefinitionCandidate(workspaceId, candidate.candidateId, {
        expectedRevision,
        payload: buildEditedPayload(candidate.payload, editFields),
        reason: editFields.reason.trim(),
      })
      setEditingDefinitionId(undefined)
    })
  }

  const submitReject = (candidate: AssetCandidateVersion): void => {
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    if (rejectReason.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写拒绝原因。' })
      return
    }
    void run(async () => {
      await client.rejectDefinitionCandidate(workspaceId, candidate.candidateId, {
        expectedRevision,
        reason: rejectReason.trim(),
      })
      setRejectingDefinitionId(undefined)
      setRejectReason('')
    })
  }

  const submitMerge = (): void => {
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    const selected = candidates.filter((candidate) => mergeSelection.includes(candidate.candidateId))
    const base = selected[0]
    if (base === undefined || selected.length < 2) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请选择至少两个同类别的候选进行合并。' })
      return
    }
    if (selected.some((candidate) => candidate.kind !== base.kind)) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '只能合并同一类别的候选。' })
      return
    }
    if (mergeReason.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '请填写合并原因。' })
      return
    }
    const mergedPayload: DefinitionCandidatePayload = {
      ...base.payload,
      displayName: mergeName.trim().length === 0 ? base.payload.displayName : mergeName.trim(),
    }
    void run(async () => {
      await client.mergeDefinitionCandidates(workspaceId, {
        expectedRevision,
        candidateIds: selected.map((candidate) => candidate.candidateId),
        mergedPayload,
        reason: mergeReason.trim(),
      })
      setMergeSelection([])
      setMergeName('')
      setMergeReason('')
    })
  }

  const submitKeepSeparate = (): void => {
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    if (mergeSelection.length < 2 || mergeReason.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '保留独立需要至少两个候选并填写原因。' })
      return
    }
    void run(async () => {
      await client.keepDefinitionCandidatesSeparate(workspaceId, {
        expectedRevision,
        candidateIds: [...mergeSelection],
        reason: mergeReason.trim(),
      })
      setMergeSelection([])
      setMergeReason('')
    })
  }

  const startEditRule = (candidate: RuleActionCandidateVersion): void => {
    if (candidate.payload.kind !== 'rule') return
    setEditingRuleId(candidate.candidateId)
    setRuleCondition(JSON.stringify(candidate.payload.condition, null, 2))
    setRuleExceptions(JSON.stringify(candidate.payload.exceptions, null, 2))
    setRuleConclusion(candidate.payload.conclusion === undefined ? '' : JSON.stringify(candidate.payload.conclusion, null, 2))
    setRuleReason('')
    setRuleEditError(undefined)
  }

  const submitRuleEdit = (candidate: RuleActionCandidateVersion): void => {
    if (candidate.payload.kind !== 'rule') return
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    const condition = parseJsonText(ruleCondition)
    const exceptions = parseJsonText(ruleExceptions)
    if (!condition.ok) {
      setRuleEditError(`条件 JSON 无效：${condition.error}`)
      return
    }
    if (!exceptions.ok || !Array.isArray(exceptions.value)) {
      setRuleEditError('例外必须是 JSON 数组。')
      return
    }
    let conclusion: unknown
    if (ruleConclusion.trim().length > 0) {
      const parsed = parseJsonText(ruleConclusion)
      if (!parsed.ok) {
        setRuleEditError(`结论 JSON 无效：${parsed.error}`)
        return
      }
      conclusion = parsed.value
    }
    if (ruleReason.trim().length === 0) {
      setRuleEditError('请填写修订原因。')
      return
    }
    const rule: RuleCandidateDraft = {
      ruleId: candidate.payload.ruleId,
      displayName: candidate.displayName,
      businessMeaning: candidate.businessMeaning,
      suggestedReason: candidate.suggestedReason,
      objectId: candidate.payload.applicability.objectId,
      ...(candidate.payload.applicability.note === undefined ? {} : { applicabilityNote: candidate.payload.applicability.note }),
      condition: condition.value,
      exceptions: exceptions.value,
      ...(conclusion === undefined ? {} : { conclusion }),
      ruleDependencies: candidate.payload.ruleDependencies,
    }
    setRuleEditError(undefined)
    void run(async () => {
      await client.editRuleCandidate(workspaceId, candidate.candidateId, {
        expectedRevision,
        rule,
        reason: ruleReason.trim(),
        sourceRefs: candidate.sourceRefs,
      })
      setEditingRuleId(undefined)
    })
  }

  const startEditAction = (candidate: RuleActionCandidateVersion): void => {
    if (candidate.payload.kind !== 'action') return
    setEditingActionId(candidate.candidateId)
    setActionDeclaration(JSON.stringify(candidate.payload.declaration, null, 2))
    setActionReason('')
    setActionEditError(undefined)
  }

  const submitActionEdit = (candidate: RuleActionCandidateVersion): void => {
    if (candidate.payload.kind !== 'action') return
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    const parsed = parseJsonText(actionDeclaration)
    if (!parsed.ok) {
      setActionEditError(`动作声明 JSON 无效：${parsed.error}`)
      return
    }
    if (actionReason.trim().length === 0) {
      setActionEditError('请填写修订原因。')
      return
    }
    setActionEditError(undefined)
    void run(async () => {
      await client.editActionCandidate(workspaceId, candidate.candidateId, {
        expectedRevision,
        action: parsed.value as ActionCandidateDraft,
        reason: actionReason.trim(),
        sourceRefs: candidate.sourceRefs,
      })
      setEditingActionId(undefined)
    })
  }

  const enableCandidate = (candidate: RuleActionCandidateVersion): void => {
    const expectedRevision = requireRevision()
    if (expectedRevision === undefined) return
    void run(async () => {
      await client.enableRuleActionCandidate(workspaceId, candidate.candidateId, { expectedRevision })
    })
  }

  const submitUnsupportedRule = (): void => {
    if (unsupportedRuleId.trim().length === 0 || unsupportedReason.trim().length === 0) {
      setActionError({ code: 'INVALID_ARGUMENT', message: '不支持的规则需要 ruleId 与原因。' })
      return
    }
    const raw = parseJsonText(unsupportedRaw)
    const rawForm: unknown = unsupportedRaw.trim().length === 0 ? unsupportedRaw : raw.ok ? raw.value : unsupportedRaw
    void run(async () => {
      await client.recordUnsupportedRule(workspaceId, {
        ruleId: unsupportedRuleId.trim(),
        reason: unsupportedReason.trim(),
        rawForm,
      })
      setUnsupportedRuleId('')
      setUnsupportedReason('')
      setUnsupportedRaw('')
    })
  }

  const toggleMergeSelection = (candidateId: string): void => {
    setMergeSelection((previous) =>
      previous.includes(candidateId)
        ? previous.filter((entry) => entry !== candidateId)
        : [...previous, candidateId],
    )
  }

  const headDraft = drafts[drafts.length - 1]
  const draftLogicalIds = new Set((headDraft?.candidateRefs ?? []).map((ref) => ref.logicalId))
  const generatedLogicalIds = new Set(candidates.map((candidate) => candidate.logicalId))
  const notInDraft = [...generatedLogicalIds].filter((logicalId) => !draftLogicalIds.has(logicalId))
  const onlyInDraft = [...draftLogicalIds].filter((logicalId) => !generatedLogicalIds.has(logicalId))

  const setEditField = (key: keyof DefinitionEditFields, value: string): void => {
    setEditFields((previous) => ({ ...previous, [key]: value }))
  }

  return (
    <section
      className="definition-workbench"
      data-testid="definition-workbench"
      data-phase={phase}
      data-workspace-id={workspaceId}
    >
      <header className="panel__header">
        <h2>定义、规则与动作审核工作台</h2>
        <p className="panel__hint">
          审核生成的定义候选、规则与动作；编辑、拒绝、合并术语都会以新修订追加并经 If-Match 校验，人工改动不会被重新生成覆盖。
        </p>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载审核工作台…' } : {})}
          {...(phase === 'failure' ? { onRecover: () => void load() } : {})}
        />
      ) : null}

      {actionError === undefined ? null : (
        <PublicStateNotice
          testId="definition-action-failure"
          failure={classifyPublicError(actionError)}
          onRecover={() => void load()}
        />
      )}

      {phase === 'empty' ? <p data-testid="definition-empty">当前没有定义或规则候选。</p> : null}

      {phase === 'ready' ? (
        <>
          <section className="definition-workbench__candidates" data-testid="definition-candidates" data-count={candidates.length}>
            <h3>定义候选</h3>
            <ul>
              {candidates.map((candidate) => {
                const stale = isCandidateStale(candidate, headRevision)
                return (
                  <li
                    key={candidate.candidateId}
                    data-testid="definition-candidate"
                    data-candidate-id={candidate.candidateId}
                    data-kind={candidate.kind}
                    data-state={candidate.state}
                    data-stale={stale}
                  >
                    {readOnly ? null : (
                      <label className="definition-workbench__select">
                        <input
                          type="checkbox"
                          data-testid="definition-merge-select"
                          checked={mergeSelection.includes(candidate.candidateId)}
                          onChange={() => toggleMergeSelection(candidate.candidateId)}
                        />
                        选择
                      </label>
                    )}
                    <strong data-testid="definition-candidate-name">{candidate.payload.displayName}</strong>
                    <span data-testid="definition-candidate-logical">{candidate.logicalId}</span>
                    <span data-testid="definition-candidate-kind">{candidate.kind}</span>
                    <span data-testid="definition-candidate-state">{candidate.state}</span>
                    <p data-testid="definition-candidate-detail">{candidateDetailLabel(candidate.payload)}</p>
                    <p data-testid="definition-candidate-meaning">{candidate.payload.businessMeaning}</p>
                    <p data-testid="definition-candidate-reason">理由：{candidate.payload.suggestedReason}</p>
                    <p data-testid="definition-candidate-source" data-source-count={candidate.sourceRefs.length}>
                      来源：{candidateSourceLabel(candidate)}
                    </p>
                    {candidate.pendingConfirmation ? (
                      <p data-testid="definition-candidate-pending">无来源定位，需人工确认后再使用。</p>
                    ) : null}
                    {candidate.payload.conflicts.length === 0 ? null : (
                      <ul data-testid="definition-candidate-conflicts">
                        {candidate.payload.conflicts.map((conflict, index) => (
                          <li key={`${conflict.kind}:${String(index)}`} data-testid="definition-candidate-conflict">
                            {conflict.kind}: {conflict.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p data-testid="definition-candidate-draft" data-stale={stale}>
                      生成于修订 {candidate.inputDraftRef.revision}；当前草稿修订 {headRevision ?? '—'}
                      {stale ? '（已过期，不覆盖人工改动）' : ''}
                    </p>
                    {readOnly ? null : (
                      <div className="definition-workbench__actions">
                        <button type="button" data-testid="definition-candidate-edit-start" disabled={busy} onClick={() => startEditDefinition(candidate)}>
                          编辑
                        </button>
                        <button type="button" data-testid="definition-candidate-reject-start" disabled={busy} onClick={() => setRejectingDefinitionId(candidate.candidateId)}>
                          拒绝
                        </button>
                      </div>
                    )}

                    {editingDefinitionId === candidate.candidateId ? (
                      <form
                        data-testid="definition-candidate-edit-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (!busy) submitDefinitionEdit(candidate)
                        }}
                      >
                        <label>
                          名称
                          <input type="text" data-testid="definition-edit-display-name" value={editFields.displayName} disabled={busy} onChange={(event) => setEditField('displayName', event.target.value)} />
                        </label>
                        <label>
                          业务含义
                          <textarea data-testid="definition-edit-business-meaning" value={editFields.businessMeaning} disabled={busy} onChange={(event) => setEditField('businessMeaning', event.target.value)} />
                        </label>
                        <label>
                          建议理由
                          <input type="text" data-testid="definition-edit-suggested-reason" value={editFields.suggestedReason} disabled={busy} onChange={(event) => setEditField('suggestedReason', event.target.value)} />
                        </label>
                        {candidate.kind === 'attribute' ? (
                          <>
                            <label>
                              值类型
                              <select data-testid="definition-edit-value-type" value={editFields.valueType} disabled={busy} onChange={(event) => setEditField('valueType', event.target.value)}>
                                {VALUE_TYPES.map((valueType) => (
                                  <option key={valueType} value={valueType}>
                                    {valueType}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              单位
                              <input type="text" data-testid="definition-edit-unit" value={editFields.unitCode} disabled={busy} onChange={(event) => setEditField('unitCode', event.target.value)} />
                            </label>
                          </>
                        ) : null}
                        {candidate.kind === 'relation' ? (
                          <>
                            <label>
                              起点对象
                              <input type="text" data-testid="definition-edit-from" value={editFields.fromObjectLogicalId} disabled={busy} onChange={(event) => setEditField('fromObjectLogicalId', event.target.value)} />
                            </label>
                            <label>
                              终点对象
                              <input type="text" data-testid="definition-edit-to" value={editFields.toObjectLogicalId} disabled={busy} onChange={(event) => setEditField('toObjectLogicalId', event.target.value)} />
                            </label>
                          </>
                        ) : null}
                        {candidate.kind === 'object' ? (
                          <label>
                            身份属性（逗号分隔）
                            <input type="text" data-testid="definition-edit-identity" value={editFields.identityAttributeIds} disabled={busy} onChange={(event) => setEditField('identityAttributeIds', event.target.value)} />
                          </label>
                        ) : null}
                        <label>
                          原因
                          <input type="text" data-testid="definition-edit-reason" value={editFields.reason} disabled={busy} onChange={(event) => setEditField('reason', event.target.value)} />
                        </label>
                        <button type="submit" data-testid="definition-edit-submit" disabled={busy}>
                          保存新候选修订
                        </button>
                      </form>
                    ) : null}

                    {rejectingDefinitionId === candidate.candidateId ? (
                      <form
                        data-testid="definition-reject-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (!busy) submitReject(candidate)
                        }}
                      >
                        <label>
                          拒绝原因
                          <input type="text" data-testid="definition-reject-reason" value={rejectReason} disabled={busy} onChange={(event) => setRejectReason(event.target.value)} />
                        </label>
                        <button type="submit" data-testid="definition-reject-submit" disabled={busy}>
                          确认拒绝
                        </button>
                      </form>
                    ) : null}
                  </li>
                )
              })}
            </ul>

            {readOnly || mergeSelection.length < 2 ? null : (
              <form
                data-testid="definition-merge-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!busy) submitMerge()
                }}
              >
                <h4>合并术语（{mergeSelection.length} 项）</h4>
                <label>
                  合并后名称
                  <input type="text" data-testid="definition-merge-name" value={mergeName} disabled={busy} onChange={(event) => setMergeName(event.target.value)} />
                </label>
                <label>
                  原因
                  <input type="text" data-testid="definition-merge-reason" value={mergeReason} disabled={busy} onChange={(event) => setMergeReason(event.target.value)} />
                </label>
                <button type="submit" data-testid="definition-merge-submit" disabled={busy}>
                  合并为同一术语
                </button>
                <button type="button" data-testid="definition-keep-separate-submit" disabled={busy} onClick={submitKeepSeparate}>
                  保留为不同含义
                </button>
              </form>
            )}
          </section>

          <section className="definition-workbench__rules" data-testid="rule-action-candidates" data-count={ruleActions.length}>
            <h3>规则与动作候选</h3>
            <ul>
              {ruleActions.map((candidate) => {
                if (candidate.payload.kind === 'rule') {
                  const support = candidate.payload.support
                  return (
                    <li
                      key={candidate.candidateId}
                      data-testid="rule-action-candidate"
                      data-candidate-id={candidate.candidateId}
                      data-kind="rule"
                      data-lifecycle={candidate.lifecycle}
                      data-support={support.supportState}
                    >
                      <strong data-testid="rule-action-name">{candidate.displayName}</strong>
                      <span data-testid="rule-action-logical">{candidate.logicalId}</span>
                      <p data-testid="rule-applicability">适用范围：{candidate.payload.applicability.objectId}</p>
                      <pre data-testid="rule-condition">{JSON.stringify(candidate.payload.condition, null, 2)}</pre>
                      <pre data-testid="rule-exceptions">{JSON.stringify(candidate.payload.exceptions, null, 2)}</pre>
                      <pre data-testid="rule-conclusion">
                        {candidate.payload.conclusion === undefined ? '无结论' : JSON.stringify(candidate.payload.conclusion, null, 2)}
                      </pre>
                      <p data-testid="rule-support" data-support-state={support.supportState}>
                        支持状态：{support.executable ? '可执行' : '暂不可执行'}（依赖深度 {support.dependencyDepth}）
                      </p>
                      {support.findings.length === 0 ? null : (
                        <ul data-testid="rule-support-findings">
                          {support.findings.map((finding, index) => (
                            <li key={`${finding.code}:${String(index)}`} data-testid="rule-support-finding">
                              {finding.code}: {finding.message}（{finding.path}）
                            </li>
                          ))}
                        </ul>
                      )}
                      {readOnly ? null : (
                        <div className="definition-workbench__actions">
                          <button type="button" data-testid="rule-edit-start" disabled={busy} onClick={() => startEditRule(candidate)}>
                            修订规则原文
                          </button>
                          <button type="button" data-testid="rule-action-enable" disabled={busy || candidate.lifecycle === 'enabled'} onClick={() => enableCandidate(candidate)}>
                            {candidate.lifecycle === 'enabled' ? '已启用' : '启用'}
                          </button>
                        </div>
                      )}
                      {editingRuleId === candidate.candidateId ? (
                        <form
                          data-testid="rule-edit-form"
                          onSubmit={(event) => {
                            event.preventDefault()
                            if (!busy) submitRuleEdit(candidate)
                          }}
                        >
                          <label>
                            条件（JSON）
                            <textarea data-testid="rule-edit-condition" value={ruleCondition} disabled={busy} onChange={(event) => setRuleCondition(event.target.value)} />
                          </label>
                          <label>
                            例外（JSON 数组）
                            <textarea data-testid="rule-edit-exceptions" value={ruleExceptions} disabled={busy} onChange={(event) => setRuleExceptions(event.target.value)} />
                          </label>
                          <label>
                            结论（JSON，可选）
                            <textarea data-testid="rule-edit-conclusion" value={ruleConclusion} disabled={busy} onChange={(event) => setRuleConclusion(event.target.value)} />
                          </label>
                          <label>
                            原因
                            <input type="text" data-testid="rule-edit-reason" value={ruleReason} disabled={busy} onChange={(event) => setRuleReason(event.target.value)} />
                          </label>
                          <button type="submit" data-testid="rule-edit-submit" disabled={busy}>
                            保存规则修订
                          </button>
                          {ruleEditError === undefined ? null : (
                            <p role="alert" data-testid="rule-edit-error">
                              {ruleEditError}
                            </p>
                          )}
                        </form>
                      ) : null}
                    </li>
                  )
                }
                const binding = candidate.payload.binding
                return (
                  <li
                    key={candidate.candidateId}
                    data-testid="rule-action-candidate"
                    data-candidate-id={candidate.candidateId}
                    data-kind="action"
                    data-lifecycle={candidate.lifecycle}
                    data-binding={binding?.status ?? 'unbound'}
                  >
                    <strong data-testid="rule-action-name">{candidate.displayName}</strong>
                    <span data-testid="rule-action-logical">{candidate.logicalId}</span>
                    <pre data-testid="action-declaration">{JSON.stringify(candidate.payload.declaration, null, 2)}</pre>
                    <p data-testid="action-binding" data-binding-status={binding?.status ?? 'unbound'}>
                      动作绑定：{binding === undefined ? '未绑定' : binding.status === 'executable' ? '已绑定可执行操作' : '不可执行'}
                    </p>
                    {binding === undefined || binding.findings.length === 0 ? null : (
                      <ul data-testid="action-binding-findings">
                        {binding.findings.map((finding, index) => (
                          <li key={`${finding.code}:${String(index)}`} data-testid="action-binding-finding">
                            {finding.code}: {finding.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {readOnly ? null : (
                      <div className="definition-workbench__actions">
                        <button type="button" data-testid="action-edit-start" disabled={busy} onClick={() => startEditAction(candidate)}>
                          修订动作声明
                        </button>
                        <button type="button" data-testid="rule-action-enable" disabled={busy || candidate.lifecycle === 'enabled'} onClick={() => enableCandidate(candidate)}>
                          {candidate.lifecycle === 'enabled' ? '已启用' : '启用'}
                        </button>
                      </div>
                    )}
                    {editingActionId === candidate.candidateId ? (
                      <form
                        data-testid="action-edit-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (!busy) submitActionEdit(candidate)
                        }}
                      >
                        <label>
                          动作声明（JSON）
                          <textarea data-testid="action-edit-declaration" value={actionDeclaration} disabled={busy} onChange={(event) => setActionDeclaration(event.target.value)} />
                        </label>
                        <label>
                          原因
                          <input type="text" data-testid="action-edit-reason" value={actionReason} disabled={busy} onChange={(event) => setActionReason(event.target.value)} />
                        </label>
                        <button type="submit" data-testid="action-edit-submit" disabled={busy}>
                          保存动作修订
                        </button>
                        {actionEditError === undefined ? null : (
                          <p role="alert" data-testid="action-edit-error">
                            {actionEditError}
                          </p>
                        )}
                      </form>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="definition-workbench__diff" data-testid="definition-version-diff">
            <h3>版本与草稿差异</h3>
            <p data-testid="definition-head-revision">当前草稿修订：{headRevision ?? '—'}</p>
            <p data-testid="compat-requires-strategy" data-requires-strategy={compatibility?.requiresRevisionStrategy ?? false}>
              {compatibility?.requiresRevisionStrategy === true ? '存在破坏性变更，发布前需显式声明修订策略。' : '无破坏性变更。'}
            </p>
            <ul data-testid="compat-additions">
              {(compatibility?.additions ?? []).map((change, index) => (
                <li key={`add:${change.logicalId}:${String(index)}`} data-testid="compat-addition">
                  {change.code} · {change.logicalId} · {change.message}
                </li>
              ))}
            </ul>
            <ul data-testid="compat-changes">
              {(compatibility?.changes ?? []).map((change, index) => (
                <li key={`change:${change.logicalId}:${String(index)}`} data-testid="compat-change" data-breaking={change.breaking}>
                  {change.code} · {change.logicalId}
                  {change.before === undefined ? '' : ` · ${change.before} → ${change.after ?? '—'}`} · {change.message}
                </li>
              ))}
            </ul>
            {(compatibility?.breakingChanges ?? []).length === 0 ? null : (
              <ul data-testid="compat-breaking-changes">
                {compatibility?.breakingChanges.map((change, index) => (
                  <li key={`breaking:${change.logicalId}:${String(index)}`} data-testid="compat-breaking">
                    {change.code} · {change.logicalId} · {change.message}
                  </li>
                ))}
              </ul>
            )}
            <p data-testid="definition-publishable">
              {validation === undefined ? '尚未校验。' : validation.publishable ? '可发布。' : `发布受阻：${String(validation.blockers.length)} 个阻断项。`}
            </p>
            <div data-testid="draft-diff">
              <p data-testid="draft-diff-generated">已生成但未进入草稿：{notInDraft.length === 0 ? '无' : notInDraft.join('、')}</p>
              <p data-testid="draft-diff-only">仅存在于草稿：{onlyInDraft.length === 0 ? '无' : onlyInDraft.join('、')}</p>
            </div>
            <ul data-testid="generation-batches">
              {batches.map((batch) => (
                <li key={batch.batchId} data-testid="generation-batch" data-stale={isCandidateStaleForBatch(batch, headRevision)}>
                  批次 {batch.batchId.slice(0, 8)} · 生成于修订 {batch.inputDraftRef.revision} · 候选 {String(batch.counts.total)} · 状态 {batch.state}
                </li>
              ))}
            </ul>
            <ul data-testid="definition-adjudications">
              {adjudications.map((adjudication) => (
                <li key={adjudication.adjudicationId} data-testid="definition-adjudication" data-kind={adjudication.kind}>
                  {adjudication.kind} · {adjudication.reason}
                </li>
              ))}
            </ul>
          </section>

          <section className="definition-workbench__unsupported" data-testid="unsupported-rules" data-count={unsupported.length}>
            <h3>不支持的规则（保留为不可执行）</h3>
            {unsupported.length === 0 ? (
              <p data-testid="unsupported-empty">没有不支持的规则。</p>
            ) : (
              <ul>
                {unsupported.map((rule) => (
                  <li key={rule.ruleId} data-testid="unsupported-rule" data-rule-id={rule.ruleId} data-executable={rule.executable}>
                    <strong>{rule.ruleId}</strong> · {rule.reason}
                    <pre data-testid="unsupported-rule-raw">{JSON.stringify(rule.rawForm)}</pre>
                  </li>
                ))}
              </ul>
            )}
            {readOnly ? null : (
              <form
                data-testid="unsupported-rule-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!busy) submitUnsupportedRule()
                }}
              >
                <label>
                  规则 ID
                  <input type="text" data-testid="unsupported-rule-id" value={unsupportedRuleId} disabled={busy} onChange={(event) => setUnsupportedRuleId(event.target.value)} />
                </label>
                <label>
                  原因
                  <input type="text" data-testid="unsupported-rule-reason" value={unsupportedReason} disabled={busy} onChange={(event) => setUnsupportedReason(event.target.value)} />
                </label>
                <label>
                  原文（JSON 或文本）
                  <textarea data-testid="unsupported-rule-raw" value={unsupportedRaw} disabled={busy} onChange={(event) => setUnsupportedRaw(event.target.value)} />
                </label>
                <button type="submit" data-testid="unsupported-rule-submit" disabled={busy}>
                  记录为不可执行
                </button>
              </form>
            )}
          </section>
        </>
      ) : null}
    </section>
  )
}

function isCandidateStaleForBatch(batch: AssetCandidateBatch, headRevision: string | undefined): boolean {
  return headRevision !== undefined && batch.inputDraftRef.revision !== headRevision
}
