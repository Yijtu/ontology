import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import type { CoreDeploymentInfo } from './api/client'
import { App } from './components/App'
import type { AppView, AppViewContribution } from './components/App'
import { resolveWebDeployment } from './deployment'
import type { WebDeployment } from './deployment'
import { Button, Panel, StateFeedback } from './components/ui'
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

function mountApp(root: Root, input: {
  readonly deployment: WebDeployment
  readonly coreDeployment?: CoreDeploymentInfo
}): void {
  const params = new URLSearchParams(window.location.search)
  const boundRunId = params.get('run') ?? undefined
  const jobId = params.get('job') ?? undefined
  const candidateId = params.get('candidate') ?? undefined
  const evidenceId = params.get('evidence') ?? undefined
  const objectId = params.get('object') ?? undefined
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
  const root = createRoot(container)
  async function attempt(): Promise<void> {
    root.render(createElement('main', { className: 'app app--startup' }, createElement(Panel, { title: '本体工作台', children: createElement(StateFeedback, { tone: 'loading', title: '正在打开工作空间', description: '读取部署场景与访问能力，请稍候。' }) })))
    const params = new URLSearchParams(window.location.search)
    const hasExplicitProfile = params.has('profileId') || params.has('profileVersion')
    try {
      if (hasExplicitProfile && !params.has('scenarioId')) {
        const deployment = resolveWebDeployment(params)
        mountApp(root, { deployment })
        return
      }

      const coreDeployment = await client.getCoreDeployment()
      const requestedScenario = params.get('scenarioId')
      const scenario = coreDeployment.scenarios.find((entry) => entry.scenarioId === requestedScenario) ?? coreDeployment.scenarios[0]
      if (scenario === undefined) throw new Error('Core deployment contains no selectable scenarios')
      const deployment: WebDeployment = {
        profileRef: hasExplicitProfile ? resolveWebDeployment(params).profileRef : scenario.profileRef,
        timeZone: params.get('timeZone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        queryContextFields: [],
        scenarioViews: [],
      }
      mountApp(root, { deployment, coreDeployment })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown startup error'
      root.render(createElement('main', { className: 'app app--startup' }, createElement(Panel, { title: '本体工作台', children:
        createElement(StateFeedback, { tone: 'error', title: '工作空间暂不可用', description: '当前部署信息未能读取。确认服务可用后，重新打开工作空间。',
          action: createElement(Button, { variant: 'primary', onClick: () => { void attempt() } }, '重新连接'),
          children: createElement('details', null, createElement('summary', null, '查看技术详情'), createElement('p', null, message)),
        }),
      })))
    }
  }
  await attempt()
}

void startWeb()
