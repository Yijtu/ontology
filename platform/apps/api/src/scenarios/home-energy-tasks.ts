import { randomUUID } from 'node:crypto'
import type { SemanticQueryPlan, VersionRef, ResourceRef, ToolContext } from '@ontology/contracts'
import { defineQueryTaskDescriptor } from '../composition/query-tasks'
import type { RegisteredQueryTask } from '../composition/query-tasks'
import { ENERGY_OPERATION_REGISTRY, ENERGY_OPERATION_INPUT_MEDIA_TYPE, decodeEnergyOperationInput, encodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { buildSyntheticScenarioInput } from '../composition/home-energy-scenario'
import type { LocalStructuredProfile } from '../composition/registered-source-profiles'
import type { ImmutableArtifactWriter, EvidenceStorePort } from '@ontology/contracts'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { DraftWriterPort as WriterPort } from '@ontology/contracts'
import { buildEnergyDraftWriter } from './task-drafts'

const ENERGY_SOC_TASK = 'energy.soc-mean'
const ENERGY_PLAN_TASK = 'energy.plan-candidate'

export function createHomeEnergyTasks(input: {
  readonly profiles: readonly LocalStructuredProfile[]
  readonly artifacts: ImmutableArtifactWriter
  readonly evidence: EvidenceStorePort
  readonly blobStore: LocalImmutableBlobStore
  readonly getVirtualState: (ctx: ToolContext) => Promise<import('../composition/energy-simulation').VirtualBatteryStateView>
}): readonly RegisteredQueryTask[] {
  const writer = buildEnergyDraftWriter({ evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore })
  return input.profiles.flatMap((profile) => [
    socTask(profile, writer),
    planTask(profile, writer, input.blobStore, input.artifacts, input.getVirtualState),
  ])
}

function socTask(profile: LocalStructuredProfile, draftWriter: WriterPort): RegisteredQueryTask {
  return {
    profileRef: profile.profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: ENERGY_SOC_TASK, version: '1.0.0', handlerVersion: '1.0.0', label: '查询站点 SOC 均值',
      description: '按选定 profile 的确认映射读取站点 SOC 并求均值。',
      fields: [{ name: 'siteRef', label: '站点 ID', kind: 'text', required: true, maxLength: 128, defaultValue: 'synthetic-home-1' }],
    }),
    draftWriter,
    supportsQuestion: (question) => /(?:\bSOC\b|荷电状态|电量百分比|剩余电量|荷电均值)/iu.test(question),
    async *execute({ taskInput, gateway, ctx }) {
      const site = taskInput['siteRef']
      if (typeof site !== 'string') { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'siteRef must be text', retryable: false } }; return }
      let queryPlan: SemanticQueryPlan
      try { queryPlan = profile.planForSite(site) } catch { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'siteRef is outside the profile input limits', retryable: false } }; return }
      yield { type: 'step_started', stepId: 'energy.soc-mean', toolId: 'data_query' }
      const result = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'semantic', queryPlan } }, ctx)
      yield { type: 'result', toolId: 'data_query', result }
    },
  }
}

function planTask(profile: LocalStructuredProfile, draftWriter: WriterPort, blobStore: LocalImmutableBlobStore, artifacts: ImmutableArtifactWriter, getVirtualState: (ctx: ToolContext) => Promise<import('../composition/energy-simulation').VirtualBatteryStateView>): RegisteredQueryTask {
  return {
    profileRef: profile.profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: ENERGY_PLAN_TASK, version: '1.0.0', handlerVersion: '1.0.0', operationRefs: ENERGY_OPERATION_REGISTRY.operations.filter((operation) => operation.operationRef.id === 'home-energy.plan').map((operation) => ({ ...operation.operationRef, digest: operation.inputSchemaDigest } satisfies VersionRef)), label: '生成储能候选计划',
      description: '先读取已映射的 SOC 作为证据，再执行注册的确定性仿真策略。',
      fields: [
        { name: 'siteRef', label: '当前 Virtual SOLIX ID', kind: 'text', required: true, maxLength: 128, defaultValue: 'virtual-solix-1' },
        { name: 'scenarioRef', label: '场景工件引用（由能源场景页面或服务端预检生成）', kind: 'text', required: false, maxLength: 2048 },
        { name: 'parentPlanRef', label: '父计划引用（由版本化场景注入）', kind: 'text', required: false, maxLength: 512 },
        { name: 'backupRequirementKwh', label: '备电保留量', kind: 'number', required: true, minimum: 0, maximum: 50, defaultValue: 2, unit: 'kWh' },
        { name: 'reserveWindowStartSlot', label: '备电窗口起始时隙', kind: 'number', required: false, minimum: 0, maximum: 95, defaultValue: 0, unit: 'slot' },
        { name: 'weatherScenario', label: '光伏天气假设', kind: 'enum', required: true, options: ['anker_base', 'afternoon_overcast', 'sunny', 'overcast', 'storm'], defaultValue: 'anker_base' },
      ],
    }),
    draftWriter,
    supportsQuestion: (question) => /(?:计划|规划|安排|调度|充放电|电费|reserve|charge|discharge)/iu.test(question) && /(?:能源|储能|电池|备电|光伏|电费|家庭|energy|battery)/iu.test(question),
    async *execute({ taskInput, gateway, ctx }) {
      const site = taskInput['siteRef'], backup = taskInput['backupRequirementKwh'], reserveStart = taskInput['reserveWindowStartSlot'], weather = taskInput['weatherScenario'], scenarioRefText = taskInput['scenarioRef']
      if (typeof site !== 'string' || typeof backup !== 'number' || typeof reserveStart !== 'number' || (weather !== 'anker_base' && weather !== 'sunny' && weather !== 'afternoon_overcast' && weather !== 'overcast' && weather !== 'storm')) {
        yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'energy task inputs do not match the registered schema', retryable: false } }; return
      }
      const plan = ENERGY_OPERATION_REGISTRY.operations.find((entry) => entry.operationRef.id === 'home-energy.plan')
      if (plan === undefined) { yield { type: 'failed', error: { code: 'CAPABILITY_NOT_CONFIGURED', message: 'energy.plan operation is not registered', retryable: false } }; return }
      let queryPlan: SemanticQueryPlan
      try { queryPlan = profile.planForSite(site) } catch { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'siteRef is outside the profile input limits', retryable: false } }; return }
      yield { type: 'step_started', stepId: 'energy.read-soc', toolId: 'data_query' }
      const soc = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'semantic', queryPlan } }, ctx)
      yield { type: 'result', toolId: 'data_query', result: soc }
      if (soc.status !== 'ok') return
      const liveState = await getVirtualState(ctx)
      let scenarioRef: ResourceRef
      let operationInput: ReturnType<typeof buildSyntheticScenarioInput>
      if (typeof scenarioRefText === 'string' && scenarioRefText.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(scenarioRefText)
          if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || !('version' in parsed) || !('digest' in parsed) || !('kind' in parsed) || (parsed as { kind: unknown }).kind !== 'artifact') throw new Error('bad ref')
          scenarioRef = parsed as ResourceRef
          operationInput = decodeEnergyOperationInput(await blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: scenarioRef }, ctx))
        } catch { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'the scenario artifact is unavailable in this run scope', retryable: false } }; return }
      } else {
        operationInput = buildSyntheticScenarioInput({ backupRequirementKwh: backup, reserveWindowStartSlot: reserveStart, weatherScenario: weather }, { energyKwh: liveState.energyKwh, revision: liveState.revision, simulatedAt: liveState.simulatedAt, ...(liveState.stateRef === undefined ? {} : { stateRef: liveState.stateRef }), ...(liveState.parentPlanRef === undefined ? {} : { parentPlanRef: liveState.parentPlanRef }) })
        const stored = await artifacts.putBytes({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, content: encodeEnergyOperationInput(operationInput), mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE }, ctx)
        scenarioRef = stored.blobRef
      }
      if (Math.abs((operationInput.reserves[0]?.reserveEnergyKwh ?? 0) - backup) > 1e-9 || (operationInput.reserves[0]?.windowStartSlot ?? 0) !== reserveStart || !operationInput.assumptions.includes(`weather_scenario=${weather}`)) { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'task inputs do not match the immutable scenario artifact', retryable: false } }; return }
      const stateRevision = Number(operationInput.assumptions.find((value) => value.startsWith('state_revision='))?.slice('state_revision='.length) ?? 'NaN')
      const snapshotRefText = operationInput.assumptions.find((value) => value.startsWith('state_ref='))?.slice('state_ref='.length)
      let snapshotStateDigest: string | undefined
      if (snapshotRefText !== undefined) { try { snapshotStateDigest = (JSON.parse(snapshotRefText) as ResourceRef).digest } catch { snapshotStateDigest = undefined } }
      const simulationStart = operationInput.assumptions.find((value) => value.startsWith('simulation_clock_start='))?.slice('simulation_clock_start='.length)
      if (stateRevision !== liveState.revision || Math.abs((operationInput.battery.initialEnergyKwh ?? Number.NaN) - liveState.energyKwh) > 1e-9 || snapshotStateDigest !== liveState.stateRef?.digest || simulationStart !== liveState.simulatedAt) { yield { type: 'failed', error: { code: 'VERIFICATION_FAILED', message: 'the scenario is based on a stale Virtual SOLIX state or simulated time; no plan was published', retryable: false } }; return }
      const inline = soc.inlineData
      const table = typeof inline === 'object' && inline !== null && !Array.isArray(inline) ? (inline as Record<string, unknown>)['table'] : undefined
      const columns = typeof table === 'object' && table !== null && !Array.isArray(table) ? (table as Record<string, unknown>)['columns'] : undefined
      const rows = typeof table === 'object' && table !== null && !Array.isArray(table) ? (table as Record<string, unknown>)['rows'] : undefined
      const socIndex = Array.isArray(columns) ? columns.findIndex((column) => typeof column === 'object' && column !== null && 'name' in column && (column as { name?: unknown }).name === 'soc_percent') : -1
      const observedSoc = Array.isArray(rows) && Array.isArray(rows[0]) && socIndex >= 0 ? Number(rows[0][socIndex]) : Number.NaN
      const plannedSoc = operationInput.battery.energyCapacityKwh === undefined || operationInput.battery.initialEnergyKwh === undefined
        ? Number.NaN
        : operationInput.battery.initialEnergyKwh / operationInput.battery.energyCapacityKwh * 100
      if (!Number.isFinite(observedSoc) || !Number.isFinite(plannedSoc) || Math.abs(observedSoc - plannedSoc) > 0.01 || Math.abs(observedSoc - liveState.socPercent) > 0.01) {
        yield { type: 'failed', error: { code: 'VERIFICATION_FAILED', message: 'the SOC source assertion does not match the plan starting state; no plan was published', retryable: false } }
        return
      }
      yield { type: 'step_started', stepId: 'energy.plan', toolId: 'data_query' }
      const planResult = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: {
        kind: 'compute', operationRef: plan.operationRef, inputSchemaDigest: plan.inputSchemaDigest,
        inputRefs: [scenarioRef], parameters: { strategyWhitelist: ['self_consumption', 'reserve_first', 'price_window'] }, dataMode: 'simulation',
      } }, ctx)
      yield { type: 'result', toolId: 'data_query', result: planResult }
    },
  }
}
