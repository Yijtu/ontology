import { useEffect, useReducer, useState } from 'react'
import type {
  ActiveProfileRecord,
  ComponentVersionRecord,
  DeploymentEnvironment,
  LogicalRole,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  SourceProbeJobRecord,
  VersionRef,
} from '@ontology/contracts'
import { ApiError, type WorkbenchClient, type BoundRunView } from '../api/client'
import {
  initialWorkbenchState,
  workbenchReducer,
  type WorkbenchError,
  type WorkbenchEvent,
} from '../state/workbench'
import { BoundRunPanel } from './BoundRunPanel'
import { CapabilityGaps } from './CapabilityGaps'
import { ComponentPicker, type CompositionSelection } from './ComponentPicker'
import { Degradations } from './Degradations'
import { SourcePanel } from './SourcePanel'
import { StatePanel } from './StatePanel'
import { useViewport } from './useViewport'

export interface WorkbenchProps {
  readonly client: WorkbenchClient
  readonly profileRef: ProfileRef
  /** The immutable base specification the operator is allowed to fork into a new version. */
  readonly baseProfileSpec?: ProfileSpec
  readonly environment?: DeploymentEnvironment
  /** Called only after the newly published profile version is activated successfully. */
  readonly onProfileActivated?: (profileRef: ProfileRef) => void
  /** When set, the locked resolved-manifest hash of that run is shown alongside the workbench. */
  readonly boundRunId?: string
}

function toWorkbenchError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'the request could not be completed',
  }
}

function failureEvent(error: unknown): WorkbenchEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toWorkbenchError(error) }
  }
  return { type: 'failed', error: toWorkbenchError(error) }
}

function firstRef(
  components: readonly ComponentVersionRecord[],
  kinds: readonly string[],
): VersionRef | undefined {
  return components.find((component) => kinds.includes(component.manifest.kind))?.manifestRef
}

function resolvedOf(preflight: PreflightResult | undefined) {
  return preflight?.status === 'resolved' ? preflight.resolvedProfile : undefined
}

function sameVersionRef(left: VersionRef | undefined, right: VersionRef | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameProfileRef(left: ProfileRef | undefined, right: ProfileRef | undefined): boolean {
  return left !== undefined && right !== undefined && left.id === right.id && left.version === right.version
}

function backendRefFromProfile(spec: ProfileSpec | undefined): VersionRef | undefined {
  if (spec === undefined) return undefined
  const firstRole = Object.keys(spec.backendBindings).sort()[0]
  return firstRole === undefined ? undefined : spec.backendBindings[firstRole]?.adapterRef
}

function initialSelection(spec: ProfileSpec | undefined): CompositionSelection {
  if (spec === undefined) return {}
  const backend = backendRefFromProfile(spec)
  return {
    industry: spec.industryRef,
    runtime: spec.runtimeRef,
    ...(backend === undefined ? {} : { backend }),
  }
}

type SelectionResolution = { readonly spec: ProfileSpec } | { readonly error: string }

const BACKEND_ROLE_CAPABILITIES: Readonly<Record<string, LogicalRole>> = {
  structured_query: 'catalog',
  document_search: 'documents',
  telemetry_read: 'telemetry',
}

function componentFor(
  components: readonly ComponentVersionRecord[],
  ref: VersionRef,
  kinds: readonly string[],
): ComponentVersionRecord | undefined {
  const selectable = components.filter(
    (component) => kinds.includes(component.manifest.kind) &&
      component.manifestRef.id === ref.id && component.manifestRef.version === ref.version,
  )
  if (selectable.length !== 1) return undefined
  const component = selectable[0]
  if (
    component === undefined ||
    !sameVersionRef(component.manifestRef, ref) ||
    component.manifest.id !== ref.id ||
    component.manifest.version !== ref.version ||
    component.manifest.digest !== ref.digest
  ) return undefined
  return component
}

/** Apply only mappings implied uniquely by the registry and the current base profile. */
function profileSpecForSelection(
  base: ProfileSpec,
  components: readonly ComponentVersionRecord[],
  selection: CompositionSelection,
): SelectionResolution {
  if (selection.industry === undefined || !sameVersionRef(selection.industry, base.industryRef)) {
    return {
      error: '所选行业包没有对应的场景映射配置，不能安全发布。请切换到已提供该行业配置的场景。',
    }
  }

  if (selection.runtime === undefined) return { error: '尚未选择 Runtime，不能发布新配置。' }
  let runtimeRef = base.runtimeRef
  if (!sameVersionRef(selection.runtime, base.runtimeRef)) {
    const runtime = componentFor(components, selection.runtime, ['runtime'])
    if (runtime === undefined) return { error: '所选 Runtime 没有唯一的已注册版本，不能发布。' }
    runtimeRef = runtime.manifestRef
  }

  let backendBindings = base.backendBindings
  if (selection.backend !== undefined) {
    const existingBinding = Object.values(base.backendBindings).find(
      (binding) => binding !== undefined && sameVersionRef(binding.adapterRef, selection.backend),
    )
    if (existingBinding === undefined) {
      const backend = componentFor(components, selection.backend, ['data_backend', 'document_backend', 'blob_backend'])
      if (backend === undefined) return { error: '所选数据后端没有唯一的已注册版本，不能发布。' }
      const roles = [...new Set(backend.manifest.provides
        .map((capability) => BACKEND_ROLE_CAPABILITIES[capability.name])
        .filter((role): role is LogicalRole => role !== undefined))]
      if (roles.length !== 1) {
        return { error: '所选数据后端不能唯一映射到当前场景的逻辑角色，不能发布。' }
      }
      const role = roles[0]
      if (role === undefined) return { error: '所选数据后端没有可用的逻辑角色映射。' }
      const bindingEntries = Object.entries(base.backendBindings).filter(([, binding]) => binding?.role === role)
      const mappings = base.mappingRefs.filter((mapping) => mapping.role === role)
      if (bindingEntries.length !== 1 || mappings.length !== 1) {
        return { error: `当前场景的 ${role} 后端或映射不是唯一配置，不能发布。` }
      }
      const [bindingKey, binding] = bindingEntries[0] ?? []
      const mapping = mappings[0]
      if (bindingKey === undefined || binding === undefined || mapping === undefined) {
        return { error: `当前场景缺少唯一的 ${role} 后端映射，不能发布。` }
      }
      // The selected adapter identifies a backend role, not a source object. Keep all
      // sourceRef/object-path data from the base and bind its unique same-role mapping id.
      backendBindings = {
        ...base.backendBindings,
        [bindingKey]: { ...binding, adapterRef: backend.manifestRef, mappingRef: mapping.id },
      }
    }
  }

  return { spec: { ...base, runtimeRef, backendBindings } }
}

function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u.test(value)
}

/**
 * The configuration workbench. It loads the registered components and sources, lets an
 * operator choose an industry/runtime/backend, preflights a profile (showing required
 * capability gaps and explicit degradations), and activates it with an `If-Match` version
 * check. It renders exactly one explicit state at a time, and it never displays secret
 * material — only the server-side `secretRef` reference.
 */
export function Workbench({
  client,
  profileRef,
  baseProfileSpec,
  environment = 'local_dev',
  onProfileActivated,
  boundRunId,
}: WorkbenchProps) {
  const viewport = useViewport()
  const [state, dispatch] = useReducer(workbenchReducer, undefined, initialWorkbenchState)
  const [currentBaseProfileSpec, setCurrentBaseProfileSpec] = useState(baseProfileSpec)
  const [selection, setSelection] = useState<CompositionSelection>(() => initialSelection(baseProfileSpec))
  const [targetProfileRef, setTargetProfileRef] = useState(profileRef)
  const [preflightProfileRef, setPreflightProfileRef] = useState<ProfileRef>()
  const [newVersion, setNewVersion] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [pendingProfileRef, setPendingProfileRef] = useState<ProfileRef>()
  const [publicationFeedback, setPublicationFeedback] = useState<{
    readonly kind: 'success' | 'error'
    readonly message: string
  }>()
  const [probeJobs, setProbeJobs] = useState<Record<string, SourceProbeJobRecord>>({})
  const [boundRun, setBoundRun] = useState<{
    readonly loading: boolean
    readonly run?: BoundRunView
    readonly error?: WorkbenchError
  }>({ loading: boundRunId !== undefined })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      dispatch({ type: 'loadStarted' })
      try {
        const [components, sources, active] = await Promise.all([
          client.listComponents(),
          client.listSources(),
          client.getActiveProfile(profileRef.id),
        ])
        if (!cancelled) dispatch({ type: 'loaded', components, sources })
        if (!cancelled && active !== undefined) dispatch({ type: 'activeLoaded', active })
      } catch (error) {
        if (!cancelled) dispatch(failureEvent(error))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [client, profileRef.id])

  useEffect(() => {
    if (state.components.length === 0) return
    setSelection((current) => {
      const defaults = initialSelection(baseProfileSpec)
      const industry = current.industry ?? defaults.industry ?? firstRef(state.components, ['industry_pack'])
      const runtime = current.runtime ?? defaults.runtime ?? firstRef(state.components, ['runtime'])
      const backend =
        current.backend ?? defaults.backend ?? firstRef(state.components, ['data_backend', 'document_backend', 'blob_backend'])
      return {
        ...(industry === undefined ? {} : { industry }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(backend === undefined ? {} : { backend }),
      }
    })
  }, [state.components, baseProfileSpec])

  useEffect(() => {
    setCurrentBaseProfileSpec(baseProfileSpec)
  }, [baseProfileSpec])

  useEffect(() => {
    setTargetProfileRef(profileRef)
    setPreflightProfileRef(undefined)
  }, [profileRef.id, profileRef.version])

  const targetPreflight = sameProfileRef(preflightProfileRef, targetProfileRef) ? state.preflight : undefined
  const resolved = resolvedOf(targetPreflight)

  const refreshActiveProfile = async (): Promise<ActiveProfileRecord | undefined> => {
    setPreflightProfileRef(undefined)
    const active = await client.getActiveProfile(profileRef.id)
    if (active !== undefined) dispatch({ type: 'activeLoaded', active })
    return active
  }

  useEffect(() => {
    if (boundRunId === undefined) return
    let cancelled = false
    setBoundRun({ loading: true })
    client
      .getRun(boundRunId)
      .then((run) => {
        if (!cancelled) setBoundRun({ loading: false, run })
      })
      .catch((error: unknown) => {
        if (!cancelled) setBoundRun({ loading: false, error: toWorkbenchError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [client, boundRunId])

  const preflight = async () => {
    setPreflightProfileRef(undefined)
    dispatch({ type: 'busy' })
    try {
      const result = await client.preflightProfile(targetProfileRef)
      setPreflightProfileRef(targetProfileRef)
      dispatch({ type: 'preflightCompleted', result })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const activate = async () => {
    const resolved = resolvedOf(targetPreflight)
    if (resolved === undefined) return
    dispatch({ type: 'busy' })
    try {
      const active = await client.activateProfile({
        profileRef: targetProfileRef,
        snapshotHash: resolved.snapshotHash,
        expectedRevision: state.active?.revision ?? null,
      })
      dispatch({ type: 'activated', active })
      try {
        onProfileActivated?.(targetProfileRef)
      } catch (error) {
        setPublicationFeedback({
          kind: 'error',
          message: `profile 已激活，但上层状态同步失败：${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toWorkbenchError(error) })
        setPublicationFeedback({
          kind: 'error',
          message: 'active revision 已变化；正在刷新当前 CAS 修订。请在刷新后重新预检再激活。',
        })
        try {
          await refreshActiveProfile()
        } catch (refreshError) {
          setPublicationFeedback({
            kind: 'error',
            message: `版本冲突后无法读取新的 active revision：${toWorkbenchError(refreshError).message}`,
          })
        }
        return
      }
      dispatch(failureEvent(error))
    }
  }

  const publishPreflightActivate = async () => {
    const version = newVersion.trim()
    const requestedRef: ProfileRef = { id: profileRef.id, version }
    setPendingProfileRef(requestedRef)
    setPublicationFeedback(undefined)
    if (currentBaseProfileSpec === undefined) return
    if (!isSemver(version)) {
      setPublicationFeedback({ kind: 'error', message: '请输入有效的 SemVer 版本，例如 1.2.3。' })
      return
    }
    const resolvedSelection = profileSpecForSelection(currentBaseProfileSpec, state.components, selection)
    if ('error' in resolvedSelection) {
      setPublicationFeedback({ kind: 'error', message: resolvedSelection.error })
      return
    }

    setPublishing(true)
    setPreflightProfileRef(undefined)
    try {
      const published = await client.publishProfile({
        profileRef: requestedRef,
        spec: resolvedSelection.spec,
        environment,
      })
      if (!sameProfileRef(published.profileRef, requestedRef)) {
        throw new Error('服务端返回的 profile 版本与请求不一致。')
      }
      setTargetProfileRef(published.profileRef)
      setPendingProfileRef(published.profileRef)
      const preflightResult = await client.preflightProfile(published.profileRef)
      setPreflightProfileRef(published.profileRef)
      dispatch({ type: 'preflightCompleted', result: preflightResult })
      const resolved = resolvedOf(preflightResult)
      if (resolved === undefined) {
        setPublicationFeedback({
          kind: 'error',
          message: '新版本已发布，但预检存在能力缺口，尚未激活。请检查缺口并调整配置后重试。',
        })
        return
      }
      const active = await client.activateProfile({
        profileRef: published.profileRef,
        snapshotHash: resolved.snapshotHash,
        expectedRevision: state.active?.revision ?? null,
      })
      setCurrentBaseProfileSpec(published.spec)
      dispatch({ type: 'activated', active })
      setPendingProfileRef(undefined)
      setNewVersion('')
      setPublicationFeedback({
        kind: 'success',
        message: `已发布并激活 ${published.profileRef.id}@${published.profileRef.version}。`,
      })
      try {
        onProfileActivated?.(published.profileRef)
      } catch (error) {
        setPublicationFeedback({
          kind: 'error',
          message: `profile 已激活，但上层状态同步失败：${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toWorkbenchError(error) })
        setPublicationFeedback({
          kind: 'error',
          message: 'active revision 已变化；正在刷新当前 CAS 修订。请在刷新后重新预检再激活。',
        })
        try {
          const active = await refreshActiveProfile()
          setPublicationFeedback({
            kind: 'error',
            message: active === undefined
              ? 'active profile 已变化且当前没有可用 revision。请重新读取配置后再试。'
              : `active profile 已更新为 ${active.profileRef.id}@${active.profileRef.version}（修订 ${active.revision}）；请重新预检后再激活。`,
          })
        } catch (refreshError) {
          setPublicationFeedback({
            kind: 'error',
            message: `版本冲突后无法读取新的 active revision：${toWorkbenchError(refreshError).message}`,
          })
        }
        return
      }
      setPublicationFeedback({ kind: 'error', message: toWorkbenchError(error).message })
    } finally {
      setPublishing(false)
    }
  }

  const probe = async (sourceId: string) => {
    dispatch({ type: 'busy' })
    try {
      const job = await client.probeSource(sourceId)
      setProbeJobs((current) => ({ ...current, [sourceId]: job }))
      const sources = await client.listSources()
      dispatch({ type: 'sourcesRefreshed', sources })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const phase = state.phase
  const showBody = phase === 'ready' || phase === 'not_configured'

  return (
    <div className={`workbench workbench--${viewport}`} data-viewport={viewport} data-phase={phase}>
      <header className="workbench__header">
        <h1>配置工作台</h1>
        <p className="workbench__hint">
          场景组合、必需能力与数据源探测。密钥仅以服务端引用（secretRef）传递，明文不会出现在本页面或事件中。
        </p>
      </header>

      {phase === 'loading' || phase === 'empty' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel phase={phase} {...(state.error === undefined ? {} : { error: state.error })} />
      ) : null}

      {phase === 'not_configured' ? (
        <StatePanel
          phase="not_configured"
          {...(state.error === undefined ? {} : { error: state.error })}
        >
          {state.preflight?.missingCapabilities === undefined ? null : (
            <CapabilityGaps missing={state.preflight.missingCapabilities} />
          )}
        </StatePanel>
      ) : null}

      {showBody ? (
        <main className="workbench__body">
          <ComponentPicker
            components={state.components}
            selection={selection}
            onChange={(nextSelection) => {
              setSelection(nextSelection)
              setPublicationFeedback(undefined)
            }}
          />

          <section className="profile-actions" data-testid="profile-actions">
            <h3>场景预检与激活</h3>
            <p data-testid="profile-ref">
              {targetProfileRef.id}@{targetProfileRef.version}
            </p>
            {currentBaseProfileSpec === undefined ? null : (
              <p>组件选择只修改待发布的新版本；当前基础配置保持不变。</p>
            )}
            <div className="profile-actions__buttons">
              <button type="button" data-testid="preflight" disabled={state.busy || publishing} onClick={() => void preflight()}>
                预检当前版本
              </button>
              <button
                type="button"
                data-testid="activate"
                disabled={state.busy || publishing || resolved === undefined}
                onClick={() => void activate()}
              >
                激活（If-Match 版本检查）
              </button>
            </div>
            {targetPreflight === undefined ? null : (
              <p data-testid="preflight-status" data-status={targetPreflight.status}>
                预检状态：{targetPreflight.status}
              </p>
            )}
            {targetPreflight?.missingCapabilities === undefined ? null : (
              <CapabilityGaps missing={targetPreflight.missingCapabilities} />
            )}
            {resolved === undefined ? null : (
              <div className="profile-actions__resolved">
                <p data-testid="snapshot-hash">清单哈希：{resolved.snapshotHash}</p>
                <Degradations degradations={resolved.explicitDegradations} />
              </div>
            )}
            {state.active === undefined ? null : (
              <p data-testid="active-revision">当前激活修订：{state.active.revision}</p>
            )}
            {state.notice === undefined ? null : (
              <p className="profile-actions__notice" data-testid="notice" role="status">
                {state.notice}
              </p>
            )}
            {state.conflict === undefined ? null : (
              <p className="profile-actions__conflict" data-testid="conflict" data-code={state.conflict.code} role="alert">
                版本冲突（{state.conflict.code}）：{state.conflict.message}
              </p>
            )}
            {currentBaseProfileSpec === undefined ? null : (
              <section data-testid="profile-publish">
                <h4>发布新配置版本</h4>
                <label>
                  新版本（SemVer）
                  <input
                    data-testid="new-profile-version"
                    value={newVersion}
                    onChange={(event) => {
                      setNewVersion(event.target.value)
                      setPublicationFeedback(undefined)
                    }}
                    disabled={publishing}
                  />
                </label>
                <button
                  type="button"
                  data-testid="publish-profile"
                  disabled={publishing || state.busy}
                  onClick={() => void publishPreflightActivate()}
                >
                  发布、预检并激活
                </button>
                {pendingProfileRef === undefined ? null : (
                  <p data-testid="pending-profile" data-profile-ref={`${pendingProfileRef.id}@${pendingProfileRef.version}`} role="status">
                    待处理版本：{pendingProfileRef.id}@{pendingProfileRef.version}
                  </p>
                )}
                {publicationFeedback === undefined ? null : (
                  <p
                    data-testid="publication-feedback"
                    data-kind={publicationFeedback.kind}
                    role={publicationFeedback.kind === 'error' ? 'alert' : 'status'}
                  >
                    {publicationFeedback.message}
                  </p>
                )}
              </section>
            )}
          </section>

          <SourcePanel sources={state.sources} probeJobs={probeJobs} busy={state.busy} onProbe={(id) => void probe(id)} />

          {boundRunId === undefined ? null : (
            <BoundRunPanel
              loading={boundRun.loading}
              {...(boundRun.run === undefined ? {} : { run: boundRun.run })}
              {...(boundRun.error === undefined ? {} : { error: boundRun.error })}
            />
          )}
        </main>
      ) : null}
    </div>
  )
}
