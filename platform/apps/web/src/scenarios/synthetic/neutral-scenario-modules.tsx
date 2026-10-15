import type { UiCapabilityMetadata, VersionRef } from '@ontology/contracts'
import type {
  FrontendScenarioModule,
  ScenarioModuleView,
  ScenarioParameterProps,
  ScenarioResultProps,
} from '../../mount/contract'

/**
 * Two isolated, industry-neutral scenario modules used to prove the mount contract
 * (SPEC v0.3a §9.3, A.US-001.AC-02 / A.US-015.AC-04). They carry no industry name, price,
 * formula or arbitrary code/URL: only a neutral task binding, a draft-bound form and a result
 * renderer over the controlled verified projection. The trusted build composition registers
 * them; deployment metadata only references their moduleRef.
 */

const ALPHA_DIGEST = `sha256:${'a1'.repeat(32)}`
const BETA_DIGEST = `sha256:${'b2'.repeat(32)}`
const TASK_DIGEST = `sha256:${'c3'.repeat(32)}`
const EXPORT_DIGEST = `sha256:${'d4'.repeat(32)}`

const ALPHA_REF: VersionRef = { id: 'scene.neutral.alpha', version: '1.0.0', digest: ALPHA_DIGEST }
const BETA_REF: VersionRef = { id: 'scene.neutral.beta', version: '1.0.0', digest: BETA_DIGEST }

const ALPHA_TASK: VersionRef = { id: 'task.neutral.alpha.run', version: '1.0.0', digest: TASK_DIGEST }
const BETA_TASK: VersionRef = { id: 'task.neutral.beta.run', version: '1.0.0', digest: TASK_DIGEST }
const EXPORT_REF: VersionRef = { id: 'capability.neutral.export', version: '1.0.0', digest: EXPORT_DIGEST }

/**
 * Test-only control for the recovery path. When armed, beta's result renderer throws on every
 * render so the shell's error boundary is reliably exercised; the harness disarms it and the
 * retry then renders the same verified version successfully.
 */
export const neutralRecoveryControl: { armed: boolean } = { armed: false }

export function armNeutralRecovery(): void {
  neutralRecoveryControl.armed = true
}

function NeutralParameters({ drafts, readOnly, moduleRef }: ScenarioParameterProps) {
  const draftKey = `${moduleRef.id}.notes`
  return (
    <form
      className="neutral-scenario__form"
      data-testid={`neutral-parameter-form-${moduleRef.id}`}
      onSubmit={(event) => event.preventDefault()}
    >
      <label>
        中性备注
        <input
          type="text"
          data-testid={`neutral-parameter-input-${moduleRef.id}`}
          value={drafts.get(draftKey)}
          readOnly={readOnly}
          onChange={(event) => drafts.set(draftKey, event.target.value)}
        />
      </label>
    </form>
  )
}

function NeutralResult({ verifiedResult }: Pick<ScenarioResultProps, 'verifiedResult'>) {
  return (
    <div className="neutral-scenario__result" data-domain-status={verifiedResult.domainStatus}>
      <p>中性场景结果：{verifiedResult.domainStatus}</p>
    </div>
  )
}

function BetaResult({ verifiedResult }: ScenarioResultProps) {
  if (neutralRecoveryControl.armed) {
    throw new Error('neutral scenario renderer failed')
  }
  return <NeutralResult verifiedResult={verifiedResult} />
}

export const NEUTRAL_ALPHA_MODULE: FrontendScenarioModule = {
  ref: ALPHA_REF,
  capabilityRequirements: ['data.readonly'],
  taskEntries: [{ taskBindingRef: ALPHA_TASK, label: '中性任务 Alpha' }],
  ParameterPanel: NeutralParameters,
  ResultRenderer: NeutralResult,
  exporters: [{ id: 'alpha-json', label: 'Alpha JSON', format: 'json', exportCapabilityRef: EXPORT_REF }],
}

export const NEUTRAL_BETA_MODULE: FrontendScenarioModule = {
  ref: BETA_REF,
  capabilityRequirements: ['data.readonly', 'pricing.compute'],
  taskEntries: [{ taskBindingRef: BETA_TASK, label: '中性任务 Beta' }],
  ParameterPanel: NeutralParameters,
  ResultRenderer: BetaResult,
  exporters: [{ id: 'beta-xlsx', label: 'Beta XLSX', format: 'xlsx', exportCapabilityRef: EXPORT_REF }],
}

export const NEUTRAL_SCENARIO_MODULES: readonly FrontendScenarioModule[] = [
  NEUTRAL_ALPHA_MODULE,
  NEUTRAL_BETA_MODULE,
]

/** Data-only declarations; the industry pack/bundle shape has no code, URL or HTML. */
export const NEUTRAL_ALPHA_DECLARATION: UiCapabilityMetadata = {
  moduleRef: ALPHA_REF,
  taskBindingRefs: [ALPHA_TASK],
  requiredCapabilities: ['data.readonly'],
}

export const NEUTRAL_BETA_DECLARATION: UiCapabilityMetadata = {
  moduleRef: BETA_REF,
  taskBindingRefs: [BETA_TASK],
  requiredCapabilities: ['pricing.compute'],
}

export const NEUTRAL_MODULE_VIEWS: readonly ScenarioModuleView[] = NEUTRAL_SCENARIO_MODULES.map(
  (module) => ({
    moduleRef: module.ref,
    taskEntries: module.taskEntries,
    capabilityRequirements: module.capabilityRequirements,
    exporters: module.exporters ?? [],
    hasParameterPanel: module.ParameterPanel !== undefined,
    hasResultRenderer: module.ResultRenderer !== undefined,
  }),
)
