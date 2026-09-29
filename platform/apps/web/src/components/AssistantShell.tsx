import { useMemo, useState } from 'react'
import type { ProjectRevisionRef, ResourceRef, VersionRef } from '@ontology/contracts'
import type {
  FrontendScenarioModule,
  ScenarioDraftStore,
  ScenarioFieldChange,
  ScenarioModuleView,
  ScenarioTaskEntry,
  ScenarioVerifiedResult,
} from '../mount/contract'
import { ScenarioModuleRegistry } from '../mount/registry'
import type { ScenarioMount } from '../mount/registry'
import { ScenarioErrorBoundary } from './ScenarioErrorBoundary'

/**
 * The public dual-assistant shell (SPEC v0.3a §9.1/§9.3, A.FR-1). Two entries with independent
 * working state; each assistant mounts the scenario modules its deployment declared. The shell
 * only understands the data-only module projection — it never imports an industry module, never
 * branches on an industry name and never renders a default quotation button. A missing module or
 * capability falls back to the generic verified result with an actionable reason.
 */

export type AssistantId = 'ontology' | 'business'

export interface AssistantDefinition {
  readonly id: AssistantId
  readonly label: string
  readonly description: string
}

export const ASSISTANT_DEFINITIONS: readonly AssistantDefinition[] = [
  { id: 'ontology', label: '本体生成助手', description: '从资料生成、审核并发布行业本体' },
  { id: 'business', label: '业务实践助手', description: '在已绑定项目上执行已发布任务' },
]

export interface AssistantModuleDeclarations {
  readonly ontology: readonly unknown[]
  readonly business: readonly unknown[]
}

export interface AssistantShellProps {
  readonly registry: ScenarioModuleRegistry
  readonly declarations: AssistantModuleDeclarations
  readonly projectRevisionRef: ProjectRevisionRef
  readonly grantedCapabilities: readonly string[]
  readonly allowedModuleRefs?: readonly VersionRef[]
  readonly readOnly?: boolean
  readonly verifiedResult?: ScenarioVerifiedResult
  readonly initialAssistant?: AssistantId
  readonly onProposeChange?: (change: ScenarioFieldChange) => void
  readonly onOpenSource?: (ref: ResourceRef) => void
  readonly onOpenEvidence?: (ref: ResourceRef) => void
  readonly onRequestExport?: (moduleRef: VersionRef, exporterId: string) => void
}

function keyOf(ref: VersionRef): string {
  return `${ref.id}@${ref.version}`
}

function GenericVerifiedResult({ result }: { readonly result: ScenarioVerifiedResult | undefined }) {
  if (result === undefined) {
    return <p data-testid="generic-verified-result-empty">暂无已核验结果</p>
  }
  return (
    <section
      className="assistant-shell__generic-result"
      data-testid="generic-verified-result"
      data-domain-status={result.domainStatus}
    >
      <h3>通用已核验结果</h3>
      <p data-testid="generic-verified-result-status">状态：{result.domainStatus}</p>
      <p data-testid="generic-verified-result-validity">有效性：{result.currentValidity}</p>
      {result.limitations.length === 0 ? null : (
        <ul data-testid="generic-verified-result-limitations">
          {result.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface ModuleSurfaceProps {
  readonly module: FrontendScenarioModule
  readonly view: ScenarioModuleView
  readonly readOnly: boolean
  readonly projectRevisionRef: ProjectRevisionRef
  readonly drafts: ScenarioDraftStore
  readonly verifiedResult?: ScenarioVerifiedResult
  readonly onProposeChange: (change: ScenarioFieldChange) => void
  readonly onOpenSource: (ref: ResourceRef) => void
  readonly onOpenEvidence: (ref: ResourceRef) => void
  readonly onRequestExport: (moduleRef: VersionRef, exporterId: string) => void
}

function ModuleSurface({
  module,
  view,
  readOnly,
  projectRevisionRef,
  drafts,
  verifiedResult,
  onProposeChange,
  onOpenSource,
  onOpenEvidence,
  onRequestExport,
}: ModuleSurfaceProps) {
  const ParameterPanel = module.ParameterPanel
  const ResultRenderer = module.ResultRenderer
  const firstTask: ScenarioTaskEntry | undefined = view.taskEntries[0]

  return (
    <section
      className="assistant-shell__module"
      data-testid={`scenario-module-${module.ref.id}`}
      data-module-ref={keyOf(module.ref)}
    >
      <header className="assistant-shell__module-header">
        <h3>{module.ref.id}</h3>
        <span data-testid={`scenario-module-tasks-${module.ref.id}`}>
          任务 {String(view.taskEntries.length)}
        </span>
      </header>
      <ul className="assistant-shell__tasks" data-testid={`scenario-task-entries-${module.ref.id}`}>
        {view.taskEntries.map((entry) => (
          <li key={entry.taskBindingRef.id}>
            <button type="button" data-testid={`task-entry-${entry.taskBindingRef.id}`}>
              {entry.label}
            </button>
          </li>
        ))}
      </ul>

      {readOnly ? (
        <p className="assistant-shell__readonly" data-testid="scenario-readonly">
          只读模式：不显示编辑、批准或发布入口。
        </p>
      ) : null}

      {ParameterPanel === undefined || readOnly || firstTask === undefined ? null : (
        <div data-testid={`scenario-parameter-${module.ref.id}`}>
          <ParameterPanel
            moduleRef={module.ref}
            taskBindingRef={firstTask.taskBindingRef}
            projectRevisionRef={projectRevisionRef}
            readOnly={readOnly}
            drafts={drafts}
            onProposeChange={onProposeChange}
            onOpenSource={onOpenSource}
          />
        </div>
      )}

      <ScenarioErrorBoundary
        resetKey={keyOf(module.ref)}
        renderFallback={(retry) => (
          <div className="assistant-shell__recovery" data-testid="scenario-recovery" role="alert">
            <p>专业视图渲染失败，已保留同一版本的公共结果。</p>
            <button type="button" data-testid="scenario-retry" onClick={retry}>
              重试
            </button>
            <GenericVerifiedResult result={verifiedResult} />
          </div>
        )}
      >
        {ResultRenderer === undefined || verifiedResult === undefined ? (
          <GenericVerifiedResult result={verifiedResult} />
        ) : (
          <div data-testid={`scenario-result-${module.ref.id}`}>
            <ResultRenderer
              moduleRef={module.ref}
              projectRevisionRef={projectRevisionRef}
              verifiedResult={verifiedResult}
              onOpenEvidence={onOpenEvidence}
              onRequestExport={(exporterId) => onRequestExport(module.ref, exporterId)}
            />
          </div>
        )}
      </ScenarioErrorBoundary>

      {readOnly || view.exporters.length === 0 ? null : (
        <div className="assistant-shell__exporters" data-testid={`scenario-exporters-${module.ref.id}`}>
          {view.exporters.map((exporter) => (
            <button
              key={exporter.id}
              type="button"
              data-testid={`exporter-${exporter.id}`}
              onClick={() => onRequestExport(module.ref, exporter.id)}
            >
              {exporter.label}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function MountPanel({ mount }: { readonly mount: ScenarioMount }) {
  switch (mount.kind) {
    case 'illegal_metadata':
      return (
        <section className="assistant-shell__state" data-testid="scenario-illegal-metadata" role="alert">
          <h3>挂载声明非法</h3>
          <p>场景挂载声明不是合法的数据投影：{mount.reason}</p>
        </section>
      )
    case 'missing_module':
      return (
        <section className="assistant-shell__state" data-testid="scenario-missing-module">
          <h3>专业视图不可用</h3>
          <p data-testid="scenario-missing-module-ref">
            {keyOf(mount.moduleRef)} 未在当前构建中注册，显示通用已核验结果。
          </p>
        </section>
      )
    case 'missing_capability':
      return (
        <section className="assistant-shell__state" data-testid="scenario-missing-capability">
          <h3>缺少所需能力</h3>
          <p data-testid="scenario-missing-capability-ref">{keyOf(mount.moduleRef)}</p>
          <ul data-testid="scenario-missing-capability-list">
            {mount.missing.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </section>
      )
    case 'forbidden':
      return (
        <section className="assistant-shell__state" data-testid="scenario-forbidden" role="alert">
          <h3>无权挂载该场景</h3>
          <p>{keyOf(mount.moduleRef)} 不在当前授权范围内。</p>
        </section>
      )
    case 'mounted':
      return null
  }
}

function noop(): void {
  return undefined
}

export function AssistantShell({
  registry,
  declarations,
  projectRevisionRef,
  grantedCapabilities,
  allowedModuleRefs,
  readOnly,
  verifiedResult,
  initialAssistant = 'ontology',
  onProposeChange,
  onOpenSource,
  onOpenEvidence,
  onRequestExport,
}: AssistantShellProps) {
  const [activeAssistant, setActiveAssistant] = useState<AssistantId>(initialAssistant)
  const [drafts, setDrafts] = useState<Record<AssistantId, Record<string, string>>>(() => ({
    ontology: {},
    business: {},
  }))
  const [activeModuleByAssistant, setActiveModuleByAssistant] = useState<
    Record<AssistantId, string | undefined>
  >({ ontology: undefined, business: undefined })

  const mounts = useMemo(() => {
    const context = {
      grantedCapabilities,
      ...(allowedModuleRefs === undefined ? {} : { allowedModuleRefs }),
      readOnly: readOnly === true,
    }
    return {
      ontology: declarations.ontology.map((declaration) => registry.mount(declaration, context)),
      business: declarations.business.map((declaration) => registry.mount(declaration, context)),
    }
  }, [registry, declarations, grantedCapabilities, allowedModuleRefs, readOnly])

  const activeDrafts = drafts[activeAssistant]
  const draftStore: ScenarioDraftStore = useMemo(
    () => ({
      get: (key) => activeDrafts[key] ?? '',
      set: (key, value) =>
        setDrafts((previous) => ({
          ...previous,
          [activeAssistant]: { ...previous[activeAssistant], [key]: value },
        })),
    }),
    [activeAssistant, activeDrafts],
  )

  const activeMounts = mounts[activeAssistant]
  const mounted = activeMounts.filter(
    (mount): mount is Extract<ScenarioMount, { kind: 'mounted' }> => mount.kind === 'mounted',
  )
  const failures = activeMounts.filter((mount) => mount.kind !== 'mounted')
  const requestedKey = activeModuleByAssistant[activeAssistant]
  const activeMounted = mounted.find((mount) => keyOf(mount.module.ref) === requestedKey) ?? mounted[0]

  const proposeChange = onProposeChange ?? noop
  const openSource = onOpenSource ?? noop
  const openEvidence = onOpenEvidence ?? noop
  const requestExport = onRequestExport ?? noop

  return (
    <div className="assistant-shell" data-testid="assistant-shell" data-active-assistant={activeAssistant}>
      <header className="assistant-shell__header">
        <h1>公共双助手</h1>
        <nav className="assistant-shell__assistants" aria-label="助手入口">
          {ASSISTANT_DEFINITIONS.map((assistant) => (
            <button
              key={assistant.id}
              type="button"
              className="assistant-shell__assistant"
              data-testid={`assistant-entry-${assistant.id}`}
              data-active={assistant.id === activeAssistant}
              aria-current={assistant.id === activeAssistant ? 'page' : undefined}
              onClick={() => setActiveAssistant(assistant.id)}
            >
              {assistant.label}
            </button>
          ))}
        </nav>
      </header>

      <section className="assistant-shell__body" data-testid={`assistant-panel-${activeAssistant}`}>
        {activeMounts.length === 0 ? (
          <p className="assistant-shell__empty" data-testid="scenario-empty">
            当前助手尚未声明任何场景模块。
          </p>
        ) : null}

        {mounted.length === 0 ? null : (
          <div className="assistant-shell__mounts" data-testid="scenario-mounted">
            <div className="assistant-shell__module-tabs" role="tablist" data-testid="scenario-module-tabs">
              {mounted.map((mount) => (
                <button
                  key={keyOf(mount.module.ref)}
                  type="button"
                  role="tab"
                  className="assistant-shell__module-tab"
                  data-testid={`scenario-module-tab-${mount.module.ref.id}`}
                  aria-selected={
                    activeMounted !== undefined && keyOf(activeMounted.module.ref) === keyOf(mount.module.ref)
                  }
                  onClick={() =>
                    setActiveModuleByAssistant((previous) => ({
                      ...previous,
                      [activeAssistant]: keyOf(mount.module.ref),
                    }))
                  }
                >
                  {mount.module.ref.id}
                </button>
              ))}
            </div>
            {activeMounted === undefined ? null : (
              <ModuleSurface
                module={activeMounted.module}
                view={activeMounted.view}
                readOnly={activeMounted.readOnly}
                projectRevisionRef={projectRevisionRef}
                drafts={draftStore}
                {...(verifiedResult === undefined ? {} : { verifiedResult })}
                onProposeChange={proposeChange}
                onOpenSource={openSource}
                onOpenEvidence={openEvidence}
                onRequestExport={requestExport}
              />
            )}
          </div>
        )}

        {failures.map((mount, index) => (
          <MountPanel key={`${mount.kind}:${String(index)}`} mount={mount} />
        ))}

        {failures.some((mount) => mount.kind === 'missing_module') ? (
          <GenericVerifiedResult result={verifiedResult} />
        ) : null}
      </section>
    </div>
  )
}
