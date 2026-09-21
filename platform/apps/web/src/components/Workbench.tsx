import { useEffect, useReducer, useState } from 'react'
import type { ComponentVersionRecord, PreflightResult, ProfileRef, SourceProbeJobRecord, VersionRef } from '@ontology/contracts'
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
  readonly profileRef?: ProfileRef
  /** When set, the locked resolved-manifest hash of that run is shown alongside the workbench. */
  readonly boundRunId?: string
}

const DEFAULT_PROFILE: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }

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

/**
 * The configuration workbench. It loads the registered components and sources, lets an
 * operator choose an industry/runtime/backend, preflights a profile (showing required
 * capability gaps and explicit degradations), and activates it with an `If-Match` version
 * check. It renders exactly one explicit state at a time, and it never displays secret
 * material — only the server-side `secretRef` reference.
 */
export function Workbench({ client, profileRef = DEFAULT_PROFILE, boundRunId }: WorkbenchProps) {
  const viewport = useViewport()
  const [state, dispatch] = useReducer(workbenchReducer, undefined, initialWorkbenchState)
  const [selection, setSelection] = useState<CompositionSelection>({})
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
        const [components, sources] = await Promise.all([client.listComponents(), client.listSources()])
        if (!cancelled) dispatch({ type: 'loaded', components, sources })
      } catch (error) {
        if (!cancelled) dispatch(failureEvent(error))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (state.components.length === 0) return
    setSelection((current) => {
      const industry = current.industry ?? firstRef(state.components, ['industry_pack'])
      const runtime = current.runtime ?? firstRef(state.components, ['runtime'])
      const backend =
        current.backend ?? firstRef(state.components, ['data_backend', 'document_backend', 'blob_backend'])
      return {
        ...(industry === undefined ? {} : { industry }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(backend === undefined ? {} : { backend }),
      }
    })
  }, [state.components])

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
    dispatch({ type: 'busy' })
    try {
      const result = await client.preflightProfile(profileRef)
      dispatch({ type: 'preflightCompleted', result })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const activate = async () => {
    const resolved = resolvedOf(state.preflight)
    if (resolved === undefined) return
    dispatch({ type: 'busy' })
    try {
      const active = await client.activateProfile({
        profileRef,
        snapshotHash: resolved.snapshotHash,
        expectedRevision: state.active?.revision ?? null,
      })
      dispatch({ type: 'activated', active })
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toWorkbenchError(error) })
        return
      }
      dispatch(failureEvent(error))
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
  const resolved = resolvedOf(state.preflight)

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
          <ComponentPicker components={state.components} selection={selection} onChange={setSelection} />

          <section className="profile-actions" data-testid="profile-actions">
            <h3>场景预检与激活</h3>
            <p data-testid="profile-ref">
              {profileRef.id}@{profileRef.version}
            </p>
            <div className="profile-actions__buttons">
              <button type="button" data-testid="preflight" disabled={state.busy} onClick={() => void preflight()}>
                预检
              </button>
              <button
                type="button"
                data-testid="activate"
                disabled={state.busy || resolved === undefined}
                onClick={() => void activate()}
              >
                激活（If-Match 版本检查）
              </button>
            </div>
            {state.preflight === undefined ? null : (
              <p data-testid="preflight-status" data-status={state.preflight.status}>
                预检状态：{state.preflight.status}
              </p>
            )}
            {state.preflight?.missingCapabilities === undefined ? null : (
              <CapabilityGaps missing={state.preflight.missingCapabilities} />
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
