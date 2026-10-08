import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import type { CoreDeploymentInfo } from './api/client'
import { App } from './components/App'
import type { AppView, AppViewContribution } from './components/App'
import { resolveWebDeployment } from './deployment'
import type { WebDeployment } from './deployment'
import './styles.css'

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''
const client = new WorkbenchClient({ baseUrl })

function initialView(params: URLSearchParams, scenarioViews: readonly AppViewContribution[], fallback: AppView): AppView {
  const requested = params.get('view')
  const coreViews = ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence']
  const allowed = [...coreViews, ...scenarioViews.map((entry) => entry.view)]
  if (requested !== null && allowed.includes(requested)) return requested
  // A bound run (`?run=`) is reproduced on the workbench, so keep that default for deep links.
  if (params.has('run')) return 'workbench'
  return fallback
}

function mountApp(container: HTMLElement, input: {
  readonly deployment: WebDeployment
  readonly coreDeployment?: CoreDeploymentInfo
}): void {
  const params = new URLSearchParams(window.location.search)
  const boundRunId = params.get('run') ?? undefined
  const jobId = params.get('job') ?? undefined
  const candidateId = params.get('candidate') ?? undefined
  const evidenceId = params.get('evidence') ?? undefined
  const objectId = params.get('object') ?? undefined
  const root = createRoot(container)
  root.render(
    createElement(App, {
      client,
      profileRef: input.deployment.profileRef,
      timeZone: input.deployment.timeZone,
      queryContextFields: input.deployment.queryContextFields,
      scenarioViews: input.deployment.scenarioViews,
      ...(input.coreDeployment === undefined ? {} : {
        deploymentScenarios: input.coreDeployment.scenarios,
        deploymentClassification: input.coreDeployment.classification,
        deploymentModels: input.coreDeployment.models,
        deploymentOperatorEnabled: input.coreDeployment.operatorEnabled,
      }),
      initialView: initialView(params, input.deployment.scenarioViews, 'start'),
      ...(boundRunId === undefined ? {} : { boundRunId }),
      ...(jobId === undefined ? {} : { initialJobId: jobId }),
      ...(candidateId === undefined ? {} : { initialCandidateId: candidateId }),
      ...(evidenceId === undefined ? {} : { initialEvidenceId: evidenceId }),
      ...(objectId === undefined ? {} : { initialObjectId: objectId }),
    }),
  )
}

async function startWeb(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) return
  const params = new URLSearchParams(window.location.search)
  const hasExplicitProfile = params.has('profileId') || params.has('profileVersion')
  try {
    if (hasExplicitProfile) {
      const deployment = resolveWebDeployment(params)
      mountApp(container, { deployment })
      return
    }

    const coreDeployment = await client.getCoreDeployment()
    const requestedScenario = params.get('scenarioId')
    const scenario = coreDeployment.scenarios.find((entry) => entry.scenarioId === requestedScenario) ?? coreDeployment.scenarios[0]
    if (scenario === undefined) throw new Error('Core deployment contains no selectable scenarios')
    const deployment: WebDeployment = {
      profileRef: scenario.profileRef,
      timeZone: params.get('timeZone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      queryContextFields: [],
      scenarioViews: [],
    }
    mountApp(container, { deployment, coreDeployment })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown startup error'
    createRoot(container).render(createElement('main', { className: 'app app--startup-error', role: 'alert' },
      createElement('h1', null, 'Core 部署暂不可用'),
      createElement('p', null, '无法读取当前 API 的场景配置。请确认本地 Core API 已就绪，或提供完整的 profileId/profileVersion。'),
      createElement('small', null, message),
    ))
  }
}

void startWeb()
