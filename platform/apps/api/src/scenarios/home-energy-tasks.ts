import { randomUUID } from 'node:crypto'
import type { SemanticQueryPlan, VersionRef } from '@ontology/contracts'
import { defineQueryTaskDescriptor } from '../composition/query-tasks'
import type { RegisteredQueryTask } from '../composition/query-tasks'
import { ENERGY_OPERATION_REGISTRY, ENERGY_OPERATION_INPUT_MEDIA_TYPE, encodeEnergyOperationInput } from '@ontology/extension-home-energy'
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
}): readonly RegisteredQueryTask[] {
  const writer = buildEnergyDraftWriter({ evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore })
  return input.profiles.flatMap((profile) => [
    socTask(profile, writer),
    planTask(profile, writer, input.artifacts),
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

function planTask(profile: LocalStructuredProfile, draftWriter: WriterPort, artifacts: ImmutableArtifactWriter): RegisteredQueryTask {
  return {
    profileRef: profile.profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: ENERGY_PLAN_TASK, version: '1.0.0', handlerVersion: '1.0.0', operationRefs: ENERGY_OPERATION_REGISTRY.operations.filter((operation) => operation.operationRef.id === 'home-energy.plan').map((operation) => ({ ...operation.operationRef, digest: operation.inputSchemaDigest } satisfies VersionRef)), label: '生成储能候选计划',
      description: '先读取已映射的 SOC 作为证据，再执行注册的确定性仿真策略。',
      fields: [
        { name: 'siteRef', label: 'SOC 查询站点 ID', kind: 'text', required: true, maxLength: 128, defaultValue: 'anker-home-1' },
        { name: 'backupRequirementKwh', label: '备电保留量', kind: 'number', required: true, minimum: 0, maximum: 50, defaultValue: 2, unit: 'kWh' },
        { name: 'weatherScenario', label: '光伏天气假设', kind: 'enum', required: true, options: ['sunny', 'overcast', 'storm'], defaultValue: 'sunny' },
      ],
    }),
    draftWriter,
    supportsQuestion: (question) => /(?:计划|规划|安排|调度|充放电|电费|reserve|charge|discharge)/iu.test(question) && /(?:能源|储能|电池|备电|光伏|电费|家庭|energy|battery)/iu.test(question),
    async *execute({ taskInput, gateway, ctx }) {
      const site = taskInput['siteRef'], backup = taskInput['backupRequirementKwh'], weather = taskInput['weatherScenario']
      if (typeof site !== 'string' || typeof backup !== 'number' || (weather !== 'sunny' && weather !== 'overcast' && weather !== 'storm')) {
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
      const operationInput = buildSyntheticScenarioInput({ backupRequirementKwh: backup, weatherScenario: weather })
      const inline = soc.inlineData
      const table = typeof inline === 'object' && inline !== null && !Array.isArray(inline) ? (inline as Record<string, unknown>)['table'] : undefined
      const columns = typeof table === 'object' && table !== null && !Array.isArray(table) ? (table as Record<string, unknown>)['columns'] : undefined
      const rows = typeof table === 'object' && table !== null && !Array.isArray(table) ? (table as Record<string, unknown>)['rows'] : undefined
      const socIndex = Array.isArray(columns) ? columns.findIndex((column) => typeof column === 'object' && column !== null && 'name' in column && (column as { name?: unknown }).name === 'soc_percent') : -1
      const observedSoc = Array.isArray(rows) && Array.isArray(rows[0]) && socIndex >= 0 ? Number(rows[0][socIndex]) : Number.NaN
      const plannedSoc = operationInput.battery.energyCapacityKwh === undefined || operationInput.battery.initialEnergyKwh === undefined
        ? Number.NaN
        : operationInput.battery.initialEnergyKwh / operationInput.battery.energyCapacityKwh * 100
      if (!Number.isFinite(observedSoc) || !Number.isFinite(plannedSoc) || Math.abs(observedSoc - plannedSoc) > 0.01) {
        yield { type: 'failed', error: { code: 'VERIFICATION_FAILED', message: 'the SOC source assertion does not match the plan starting state; no plan was published', retryable: false } }
        return
      }
      const stored = await artifacts.putBytes({
        scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
        content: encodeEnergyOperationInput(operationInput),
        mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE,
      }, ctx)
      yield { type: 'step_started', stepId: 'energy.plan', toolId: 'data_query' }
      const planResult = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: {
        kind: 'compute', operationRef: plan.operationRef, inputSchemaDigest: plan.inputSchemaDigest,
        inputRefs: [stored.blobRef], parameters: { strategyWhitelist: ['self_consumption', 'reserve_first', 'price_window'] }, dataMode: 'simulation',
      } }, ctx)
      yield { type: 'result', toolId: 'data_query', result: planResult }
    },
  }
}
