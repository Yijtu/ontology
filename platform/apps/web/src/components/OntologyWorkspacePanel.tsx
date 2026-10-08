import { useCallback, useEffect, useState } from 'react'
import type { AssetDraftVersion, IndustryWorkspace, IndustryWorkspaceBoundary, ResourceRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { ApiError } from '../api/errors'
import type { WorkspaceIdentity } from '../workspace-identity'
import { webWorkspaceIdentity } from '../workspace-identity'
import { StatePanel } from './StatePanel'
import { PublicEmptyState, PublicStateNotice } from './PublicStateNotice'
import { classifyPublicError } from '../state/public-errors'
import type { PublicFailure } from '../state/public-errors'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'
import { WorkspaceSourcesPanel } from './WorkspaceSourcesPanel'

/**
 * The public ontology-workspace home (SPEC v0.3a §9.1/§9.2, A.US-001, P.US-002). It lists the
 * industry workspaces visible in the trusted scope, creates one from a filled business boundary,
 * continues one by reading its immutable draft revisions, and edits the name/boundary through
 * If-Match CAS. Every read is a real HTTP call, so an ordinary refresh reads the same workspace
 * back from the server instead of trusting local state.
 *
 * The panel is generic: it never names an industry and mounts no professional view. Scenario UI
 * stays behind the V03-022 mount registry.
 */

export interface OntologyWorkspacePanelProps {
  readonly client: WorkbenchClient
  readonly identity?: WorkspaceIdentity
  readonly readOnly?: boolean
}

export interface WorkspaceCreateFields {
  displayName: string
  namespace: string
  goals: string
  included: string
  excluded: string
  region: string
  validFrom: string
  validTo: string
}

export const EMPTY_CREATE_FIELDS: WorkspaceCreateFields = {
  displayName: '',
  namespace: '',
  goals: '',
  included: '',
  excluded: '',
  region: '',
  validFrom: '',
  validTo: '',
}

function linesOf(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function boundaryOf(fields: WorkspaceCreateFields): IndustryWorkspaceBoundary {
  return {
    goals: linesOf(fields.goals),
    included: linesOf(fields.included),
    excluded: linesOf(fields.excluded),
    applicability: {
      ...(fields.region.trim().length === 0 ? {} : { region: fields.region.trim() }),
      ...(fields.validFrom.trim().length === 0 ? {} : { validFrom: fields.validFrom.trim() }),
      ...(fields.validTo.trim().length === 0 ? {} : { validTo: fields.validTo.trim() }),
    },
  }
}

/**
 * Required-field validation (P.US-002.AC-01). Each missing field is localised so the form can
 * point at it; a boundary with no goals is rejected here even though the server schema is lenient
 * about an empty array.
 */
export function validateCreateFields(fields: WorkspaceCreateFields): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {}
  if (fields.displayName.trim().length === 0) errors['displayName'] = '请填写工作区名称。'
  if (fields.namespace.trim().length === 0) errors['namespace'] = '请填写行业命名空间。'
  if (linesOf(fields.goals).length === 0) errors['goals'] = '请至少填写一个业务目标。'
  return errors
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

function canonicalInitialSourceSet(input: {
  readonly namespace: string
  readonly displayName: string
  readonly boundary: IndustryWorkspaceBoundary
}): string {
  return JSON.stringify({
    kind: 'industry-source-set',
    namespace: input.namespace,
    displayName: input.displayName,
    boundary: input.boundary,
    sources: [],
  })
}

function workspaceQuery(workspaceId: string | undefined): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (workspaceId === undefined) url.searchParams.delete('workspace')
  else url.searchParams.set('workspace', workspaceId)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function OntologyWorkspacePanel({
  client,
  identity = webWorkspaceIdentity,
  readOnly = false,
}: OntologyWorkspacePanelProps) {
  const [workspaces, setWorkspaces] = useState<readonly IndustryWorkspace[]>([])
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [drafts, setDrafts] = useState<readonly AssetDraftVersion[]>([])
  const [fields, setFields] = useState<WorkspaceCreateFields>(EMPTY_CREATE_FIELDS)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [createFailure, setCreateFailure] = useState<PublicFailure | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [editFailure, setEditFailure] = useState<WorkbenchError | undefined>(undefined)
  const [editFields, setEditFields] = useState<WorkspaceCreateFields>(EMPTY_CREATE_FIELDS)
  const [editMode, setEditMode] = useState(false)

  const selected = workspaces.find((workspace) => workspace.workspaceId === selectedId)

  const loadDrafts = useCallback(
    async (workspaceId: string): Promise<void> => {
      const list = await client.listIndustryWorkspaceDrafts(workspaceId)
      setDrafts(list)
    },
    [client],
  )

  const loadList = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const list = await client.listIndustryWorkspaces()
      setWorkspaces(list)
      const requested = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search).get('workspace')
      const matching = list.find((workspace) => workspace.workspaceId === requested)
      setSelectedId((previous) => {
        const candidate = matching?.workspaceId ?? previous
        return candidate !== undefined && list.some((workspace) => workspace.workspaceId === candidate)
          ? candidate
          : list[0]?.workspaceId
      })
      setPhase(list.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selectedId === undefined) {
      setDrafts([])
      return
    }
    void loadDrafts(selectedId).catch((caught: unknown) => {
      setError(toError(caught))
    })
  }, [selectedId, loadDrafts])

  useEffect(() => {
    if (!editMode || selected === undefined) return
    setEditFields({
      displayName: selected.displayName,
      namespace: selected.namespace,
      goals: selected.boundary.goals.join('\n'),
      included: selected.boundary.included.join('\n'),
      excluded: selected.boundary.excluded.join('\n'),
      region: selected.boundary.applicability.region ?? '',
      validFrom: selected.boundary.applicability.validFrom ?? '',
      validTo: selected.boundary.applicability.validTo ?? '',
    })
  }, [editMode, selected])

  const selectWorkspace = (workspaceId: string): void => {
    setSelectedId(workspaceId)
    setEditMode(false)
    workspaceQuery(workspaceId)
  }

  const create = async (): Promise<void> => {
    const errors = validateCreateFields(fields)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setCreateFailure(classifyPublicError({ code: 'INVALID_ARGUMENT', message: '请先修正标记的必填项。' }))
      return
    }
    setBusy(true)
    setCreateFailure(undefined)
    try {
      const boundary = boundaryOf(fields)
      const digest = await identity.sha256(
        canonicalInitialSourceSet({ namespace: fields.namespace.trim(), displayName: fields.displayName.trim(), boundary }),
      )
      const documentSetRef: ResourceRef = { id: identity.newId(), version: '1.0.0', digest, kind: 'artifact' }
      const view = await client.createIndustryWorkspace({
        namespace: fields.namespace.trim(),
        displayName: fields.displayName.trim(),
        boundary,
        documentSetRef,
      })
      setFields(EMPTY_CREATE_FIELDS)
      setWorkspaces((previous) => [view.workspace, ...previous])
      selectWorkspace(view.workspace.workspaceId)
      setPhase('ready')
    } catch (caught) {
      setCreateFailure(classifyPublicError(toError(caught)))
    } finally {
      setBusy(false)
    }
  }

  const edit = async (): Promise<void> => {
    if (selected === undefined) return
    const errors = validateCreateFields(editFields)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setEditFailure({ code: 'INVALID_ARGUMENT', message: '请先修正标记的必填项。' })
      return
    }
    setBusy(true)
    setEditFailure(undefined)
    try {
      const view = await client.editIndustryWorkspace(selected.workspaceId, {
        expectedRevision: selected.headRevision,
        reason: 'clarify workspace boundary',
        displayName: editFields.displayName.trim(),
        boundary: boundaryOf(editFields),
      })
      setWorkspaces((previous) =>
        previous.map((workspace) => (workspace.workspaceId === view.workspace.workspaceId ? view.workspace : workspace)),
      )
      setEditMode(false)
      await loadDrafts(view.workspace.workspaceId)
    } catch (caught) {
      setEditFailure(toError(caught))
    } finally {
      setBusy(false)
    }
  }

  const registerSourceSet = async (documentSetRef: ResourceRef, reason: string): Promise<void> => {
    if (selected === undefined) throw new Error('select a workspace before registering a source set')
    const view = await client.appendIndustryWorkspaceDraft(selected.workspaceId, {
      expectedRevision: selected.headRevision,
      reason,
      documentSetRef,
    })
    setWorkspaces((previous) =>
      previous.map((workspace) => (workspace.workspaceId === view.workspace.workspaceId ? view.workspace : workspace)),
    )
    await loadDrafts(view.workspace.workspaceId)
  }

  const setField = (key: keyof WorkspaceCreateFields, value: string): void => {
    setFields((previous) => ({ ...previous, [key]: value }))
  }

  const setEditField = (key: keyof WorkspaceCreateFields, value: string): void => {
    setEditFields((previous) => ({ ...previous, [key]: value }))
  }

  return (
    <section className="ontology-workspace" data-testid="ontology-workspace" data-phase={phase}>
      <header className="panel__header">
        <h2>本体工作区</h2>
        <p className="panel__hint">创建、继续或切换行业本体工作区；保存后有稳定的工作区标识与草稿修订，刷新回读一致。</p>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载本体工作区…' } : {})}
          {...(phase === 'failure' ? { onRecover: () => void loadList() } : {})}
        />
      ) : null}

      {phase === 'empty' ? (
        <PublicEmptyState
          testId="workspace-empty"
          title="尚无本体工作区"
          requirement="业务范围说明，以及要纳入的资料来源。"
          nextStep="填写下方表单的显示名、命名空间与目标，创建第一个工作区。"
        />
      ) : null}

      {phase === 'ready' ? (
        <div className="ontology-workspace__list" data-testid="workspace-list">
          <h3>已有工作区</h3>
          <ul>
            {workspaces.map((workspace) => (
              <li key={workspace.workspaceId}>
                <button
                  type="button"
                  data-testid="workspace-list-item"
                  data-workspace-id={workspace.workspaceId}
                  data-selected={workspace.workspaceId === selectedId}
                  aria-pressed={workspace.workspaceId === selectedId}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  {workspace.displayName}（{workspace.namespace} · 修订 {workspace.headRevision} · {workspace.state}）
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {readOnly ? null : (
        <form
          className="ontology-workspace__create"
          data-testid="workspace-create-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy) void create()
          }}
        >
          <h3>新建工作区</h3>
          <label className="ontology-workspace__field">
            <span>工作区名称</span>
            <input
              type="text"
              data-testid="workspace-create-display-name"
              value={fields.displayName}
              disabled={busy}
              onChange={(event) => setField('displayName', event.target.value)}
            />
            {fieldErrors['displayName'] === undefined ? null : (
              <small data-testid="workspace-create-error-displayName">{fieldErrors['displayName']}</small>
            )}
          </label>
          <label className="ontology-workspace__field">
            <span>行业命名空间</span>
            <input
              type="text"
              data-testid="workspace-create-namespace"
              value={fields.namespace}
              disabled={busy}
              onChange={(event) => setField('namespace', event.target.value)}
            />
            {fieldErrors['namespace'] === undefined ? null : (
              <small data-testid="workspace-create-error-namespace">{fieldErrors['namespace']}</small>
            )}
          </label>
          <label className="ontology-workspace__field ontology-workspace__field--wide">
            <span>业务目标（每行一个）</span>
            <textarea
              data-testid="workspace-create-goals"
              value={fields.goals}
              disabled={busy}
              onChange={(event) => setField('goals', event.target.value)}
            />
            {fieldErrors['goals'] === undefined ? null : (
              <small data-testid="workspace-create-error-goals">{fieldErrors['goals']}</small>
            )}
          </label>
          <label className="ontology-workspace__field">
            <span>包含范围（每行一个）</span>
            <textarea
              data-testid="workspace-create-included"
              value={fields.included}
              disabled={busy}
              onChange={(event) => setField('included', event.target.value)}
            />
          </label>
          <label className="ontology-workspace__field">
            <span>排除范围（每行一个）</span>
            <textarea
              data-testid="workspace-create-excluded"
              value={fields.excluded}
              disabled={busy}
              onChange={(event) => setField('excluded', event.target.value)}
            />
          </label>
          <label className="ontology-workspace__field">
            <span>适用地区</span>
            <input
              type="text"
              data-testid="workspace-create-region"
              value={fields.region}
              disabled={busy}
              onChange={(event) => setField('region', event.target.value)}
            />
          </label>
          <label className="ontology-workspace__field">
            <span>生效时间</span>
            <input
              type="text"
              data-testid="workspace-create-valid-from"
              value={fields.validFrom}
              disabled={busy}
              onChange={(event) => setField('validFrom', event.target.value)}
            />
          </label>
          <label className="ontology-workspace__field">
            <span>失效时间</span>
            <input
              type="text"
              data-testid="workspace-create-valid-to"
              value={fields.validTo}
              disabled={busy}
              onChange={(event) => setField('validTo', event.target.value)}
            />
          </label>
          <button type="submit" data-testid="workspace-create-submit" disabled={busy}>
            {busy ? '保存中…' : '创建工作区'}
          </button>
          {createFailure === undefined ? null : (
            <PublicStateNotice
              testId="workspace-create-failure"
              failure={createFailure}
              onRecover={() => void create()}
            />
          )}
        </form>
      )}

      {selected === undefined ? null : (
        <div className="ontology-workspace__detail" data-testid="workspace-detail" data-workspace-id={selected.workspaceId}>
          <h3 data-testid="workspace-detail-name">{selected.displayName}</h3>
          <dl>
            <dt>命名空间</dt>
            <dd data-testid="workspace-detail-namespace">{selected.namespace}</dd>
            <dt>修订</dt>
            <dd data-testid="workspace-detail-head-revision">{selected.headRevision}</dd>
            <dt>状态</dt>
            <dd data-testid="workspace-detail-state">{selected.state}</dd>
            <dt>业务目标</dt>
            <dd data-testid="workspace-detail-goals">{selected.boundary.goals.join('；')}</dd>
            <dt>适用地区</dt>
            <dd data-testid="workspace-detail-region">{selected.boundary.applicability.region ?? '—'}</dd>
          </dl>

          {readOnly ? null : (
            <div className="ontology-workspace__edit">
              <button
                type="button"
                data-testid="workspace-edit-start"
                disabled={busy}
                onClick={() => setEditMode((previous) => !previous)}
              >
                {editMode ? '取消编辑' : '编辑边界'}
              </button>
              {editMode ? (
                <form
                  data-testid="workspace-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!busy) void edit()
                  }}
                >
                  <label className="ontology-workspace__field">
                    <span>工作区名称</span>
                    <input
                      type="text"
                      data-testid="workspace-edit-display-name"
                      value={editFields.displayName}
                      disabled={busy}
                      onChange={(event) => setEditField('displayName', event.target.value)}
                    />
                  </label>
                  <label className="ontology-workspace__field ontology-workspace__field--wide">
                    <span>业务目标（每行一个）</span>
                    <textarea
                      data-testid="workspace-edit-goals"
                      value={editFields.goals}
                      disabled={busy}
                      onChange={(event) => setEditField('goals', event.target.value)}
                    />
                  </label>
                  <button type="submit" data-testid="workspace-edit-submit" disabled={busy}>
                    {busy ? '保存中…' : '保存新草稿修订'}
                  </button>
                  {editFailure === undefined ? null : (
                    <PublicStateNotice
                      testId="workspace-edit-failure"
                      failure={classifyPublicError(editFailure)}
                      onRecover={() => void loadDrafts(selected.workspaceId)}
                    />
                  )}
                </form>
              ) : null}
            </div>
          )}

          <div className="ontology-workspace__drafts" data-testid="workspace-drafts" data-count={drafts.length}>
            <h4>草稿修订</h4>
            {drafts.length === 0 ? (
              <p data-testid="workspace-drafts-empty">尚无草稿修订。</p>
            ) : (
              <ul>
                {drafts.map((draft) => (
                  <li key={draft.revision} data-testid="workspace-draft" data-revision={draft.revision}>
                    修订 {draft.revision} · 资料集 {draft.documentSetRef.id} · 候选 {draft.candidateRefs.length}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <WorkspaceSourcesPanel
            client={client}
            workspace={selected}
            identity={identity}
            readOnly={readOnly}
            onRegisterSourceSet={registerSourceSet}
          />
        </div>
      )}
    </section>
  )
}
