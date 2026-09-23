import { useReducer } from 'react'
import type { OperationRef } from '@ontology/contracts'
import type { ProfileRef } from '@ontology/contracts'
import { ApiError, type WorkbenchClient } from '../api/client'
import { asPlanResult, WEATHER_SCENARIOS } from '../api/energy'
import type { PlanCandidateView, WeatherScenario } from '../api/energy'
import {
  energyReducer,
  initialEnergyState,
  type EnergyEvent,
  type EnergyPlanVersion,
} from '../state/energy'
import type { WorkbenchError } from '../state/workbench'
import { Datum } from './Datum'
import { StatePanel } from './StatePanel'
import { useViewport } from './useViewport'

/**
 * The home-energy plan, comparison and simulation surface (US-021/US-022, FR-18/21/33; E8).
 *
 * It renders exactly the labels the server returned: every number goes through `Datum`, so it
 * always carries a unit, a source, a time and a `synthetic`/`forecast`/`observed`/`simulated`
 * mode. A simulated benefit is shown as a **simulated** figure and is never worded as an actual
 * bill saving. Changing the backup requirement or the weather scenario archives a new
 * content-addressed scenario, so the next plan is a new version; the panel then shows the
 * constraint gaps and the source changes against the previous version.
 *
 * Only a result whose content digest the server verified is rendered as numbers; an unverified
 * or unrecognised payload is an explicit notice. Simulation and live execution are never
 * conflated: a `mode=live` attempt is rendered as `CAPABILITY_NOT_CONFIGURED`, not as a run.
 */
export interface EnergyPlanPanelProps {
  readonly client: WorkbenchClient
  readonly profileRef: ProfileRef
  readonly publishedExecutionRequired?: boolean
}

const PLAN_OPERATION: OperationRef = { id: 'home-energy.plan', version: '1' }
const SIMULATE_OPERATION: OperationRef = { id: 'home-energy.simulate', version: '1' }
const STRATEGY_WHITELIST = ['self_consumption', 'reserve_first', 'price_window'] as const

function toEnergyError(error: unknown): WorkbenchError {
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

function failureEvent(error: unknown): EnergyEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toEnergyError(error) }
  }
  if (error instanceof ApiError && error.code === 'CAPABILITY_NOT_CONFIGURED') {
    return { type: 'notConfigured', error: toEnergyError(error) }
  }
  return { type: 'failed', error: toEnergyError(error) }
}

function formatNumber(value: number, decimals = 3): string {
  return value.toFixed(decimals)
}

function selectedPlanRef(version: EnergyPlanVersion): PlanCandidateView['planRef'] | undefined {
  const result = version.result
  if (result === undefined) return undefined
  const strategy = result.selection.selectedStrategy
  const selected =
    strategy === undefined ? undefined : result.candidates.find((candidate) => candidate.strategy === strategy)
  return selected?.planRef ?? result.candidates[0]?.planRef ?? result.baseline?.planRef
}

function CandidateCard({
  version,
  candidate,
  simulatedSaving,
}: {
  readonly version: EnergyPlanVersion
  readonly candidate: PlanCandidateView
  readonly simulatedSaving: { readonly amount: number; readonly currency: string } | undefined
}) {
  const source = version.result?.algorithmVersion.id ?? 'home-energy.planner'
  const time = version.record.createdAt
  const mode = candidate.simulation.executionMode === 'simulation' ? 'simulated' : 'synthetic'
  return (
    <li className="energy__candidate" data-testid="plan-candidate" data-strategy={candidate.strategy}>
      <span className="energy__candidate-name" data-testid="candidate-strategy">
        {candidate.strategy}
      </span>
      <Datum
        testId="candidate-net-cost"
        label="净成本"
        value={formatNumber(candidate.objective.netCost)}
        unit={candidate.objective.currency}
        source={source}
        time={time}
        mode={mode}
      />
      <Datum
        testId="candidate-terminal-energy"
        label="期末电量"
        value={formatNumber(candidate.objective.terminalEnergyKwh)}
        unit="kWh"
        source={source}
        time={time}
        mode={mode}
      />
      <Datum
        testId="candidate-reserve-satisfied"
        label="备电满足"
        value={candidate.objective.reserveSatisfied ? '是' : '否'}
        unit="boolean"
        source={source}
        time={time}
        mode={mode}
      />
      {simulatedSaving === undefined ? null : (
        <Datum
          testId="simulated-saving"
          kind="simulated_saving"
          label="模拟净收益（非实际账单）"
          value={formatNumber(simulatedSaving.amount)}
          unit={simulatedSaving.currency}
          source={source}
          time={time}
          mode="simulated"
        />
      )}
    </li>
  )
}

function VersionCard({ version }: { readonly version: EnergyPlanVersion }) {
  const result = version.result
  const verified = version.detail.integrityVerified
  const comparison = result?.comparisons.find((entry) => entry.savingsClaim)
  const simulatedSaving =
    comparison === undefined
      ? undefined
      : { amount: Math.abs(comparison.adjustedCostDelta ?? comparison.rawCostDelta), currency: comparison.currency }
  return (
    <article className="energy__version" data-testid="plan-version" data-version-id={version.versionId}>
      <header className="energy__version-head">
        <h3>
          计划版本 <span data-testid="plan-version-id">{version.versionId.slice(0, 18)}…</span>
        </h3>
        <span className="energy__badge" data-testid="plan-mode" data-mode="simulation">
          simulation
        </span>
        {verified ? (
          <span className="energy__badge energy__badge--ok" data-testid="plan-verified" data-verified="true">
            已核验（内容摘要一致）
          </span>
        ) : (
          <span className="energy__badge energy__badge--warn" data-testid="plan-unverified" data-verified="false">
            未通过内容核验
          </span>
        )}
      </header>
      <p data-testid="plan-version-status" data-status={result?.status ?? 'unknown'}>
        状态：{result?.status ?? 'unknown'}（domainStatus：{result?.domainStatus ?? 'unknown'}）
      </p>
      <p data-testid="plan-selected-strategy">
        选中策略：{result?.selection.selectedStrategy ?? '无可行候选'}
      </p>
      <p data-testid="plan-input-hash">输入清单哈希：{result?.inputManifestHash ?? 'unknown'}</p>
      {!verified ? (
        <p className="energy__unverified" data-testid="plan-unverified-note" role="alert">
          该结果未通过内容摘要核验，按规范不展示任何数值。
        </p>
      ) : result === undefined ? (
        <p className="energy__unverified" data-testid="plan-unrecognized" role="alert">
          返回结果无法识别为计划结果，按规范不展示任何数值。
        </p>
      ) : (
        <ul className="energy__candidates">
          {(result.baseline === undefined ? result.candidates : [result.baseline, ...result.candidates]).map(
            (candidate) => (
              <CandidateCard
                key={candidate.strategy}
                version={version}
                candidate={candidate}
                simulatedSaving={comparison?.strategy === candidate.strategy ? simulatedSaving : undefined}
              />
            ),
          )}
        </ul>
      )}
      {result === undefined || verified !== true ? null : result.comparisons.length === 0 ? null : (
        <div className="energy__savings" data-testid="savings-panel">
          {result.comparisons.map((entry) =>
            entry.savingsClaim ? (
              <Datum
                key={entry.strategy}
                testId="saving-claim"
                kind="simulated_saving"
                label="模拟净收益（非实际账单）"
                value={formatNumber(Math.abs(entry.adjustedCostDelta ?? entry.rawCostDelta))}
                unit={entry.currency}
                source={result.algorithmVersion.id}
                time={version.record.createdAt}
                mode="simulated"
              />
            ) : (
              <p key={entry.strategy} className="energy__refusal" data-testid="saving-refused" data-refusal={entry.refusal ?? 'not_comparable'}>
                口径不同，拒绝无口径的节省声明：{entry.refusal ?? 'not_comparable'}
              </p>
            ),
          )}
        </div>
      )}
    </article>
  )
}

export function EnergyPlanPanel({ client, profileRef, publishedExecutionRequired = false }: EnergyPlanPanelProps) {
  const viewport = useViewport()
  const [state, dispatch] = useReducer(energyReducer, undefined, initialEnergyState)
  const phase = state.phase
  const latest = state.versions[state.versions.length - 1]

  const buildScenario = async () => {
    dispatch({ type: 'busy' })
    try {
      const scenario = await client.buildEnergyScenario({
        reserveSocPercent: state.backupRequirementKwh / 10 * 100,
        weatherScenario: state.weatherScenario,
      })
      dispatch({ type: 'scenarioBuilt', scenario })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const requestPlan = async () => {
    const scenario = state.scenario
    if (scenario === undefined) return
    dispatch({ type: 'busy' })
    try {
      const record = await client.requestSimulation({
        operationRef: PLAN_OPERATION,
        inputRefs: [scenario.inputRef],
        parameters: { strategyWhitelist: [...STRATEGY_WHITELIST] },
      })
      const detail = await client.getSimulation(record.simulationId)
      const planResult = asPlanResult(detail.result)
      const previewRef = planResult === undefined ? undefined : (planResult.selection.selectedStrategy === undefined
        ? planResult.candidates[0]?.planRef ?? planResult.baseline?.planRef
        : planResult.candidates.find((candidate) => candidate.strategy === planResult.selection.selectedStrategy)?.planRef ?? planResult.baseline?.planRef)
      if (previewRef === undefined) throw new Error('仿真结果没有选中可执行候选计划。')
      const version: EnergyPlanVersion = {
        versionId: detail.scenario.inputDigest,
        scenario: detail.scenario,
        record,
        detail,
        result: planResult,
        publishedRunId: '',
        executionPlanRef: previewRef,
        executionInputRefs: record.inputRefs,
      }
      let officialRunId = ''
      let executionPlanRef = version.executionPlanRef
      if (publishedExecutionRequired) {
      const officialRun = await client.createRun({
        profileRef,
        question: '为家庭储能能源系统生成满足备电目标的确定性充放电计划。',
        context: { timeZone: 'Asia/Shanghai', taskId: 'energy.plan-candidate', taskInput: { siteRef: 'anker-home-1', backupRequirementKwh: state.backupRequirementKwh, weatherScenario: state.weatherScenario } },
        preferences: { route: 'auto', allowWeb: false },
      })
      let published = false
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const answer = await client.getAnswer(officialRun.runId)
        if (answer.kind === 'published') { published = true; break }
        if (answer.kind === 'unavailable') {
          const run = await client.getRun(officialRun.runId)
          throw new Error(`能源计划未能发布：${answer.code}（run state=${run.state}）`)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250))
      }
      if (!published) throw new Error('等待正式核验计划超时；本次直接计算预览不会开放执行。')
      const authorizedPlan = await client.getLocalPlan(officialRun.runId)
      const previewPlanRef = selectedPlanRef(version)
      if (previewPlanRef === undefined || previewPlanRef.digest !== authorizedPlan.selectedPlanRef.digest || previewPlanRef.id !== authorizedPlan.selectedPlanRef.id) throw new Error('直接预览与正式发布计划不一致；已停止执行授权。')
      officialRunId = officialRun.runId
      executionPlanRef = authorizedPlan.selectedPlanRef
      }
      dispatch({ type: 'planLoaded', version: { ...version, publishedRunId: officialRunId, executionPlanRef } })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const requestExecution = async (mode: 'simulation' | 'live') => {
    if (latest === undefined) return
      const planRef = selectedPlanRef(latest)
    if (planRef === undefined || (publishedExecutionRequired && latest.publishedRunId.length === 0)) {
      dispatch({ type: 'notice', message: '当前没有与正式核验答案绑定的可执行计划。' })
      return
    }
    dispatch({ type: 'busy' })
    try {
      const execution = await client.requestExecution({
        runId: latest.publishedRunId || globalThis.crypto.randomUUID(),
        operationRef: SIMULATE_OPERATION,
        planRef: latest.executionPlanRef,
        inputRefs: latest.executionInputRefs,
        mode,
      })
      dispatch({ type: 'executionLoaded', execution })
    } catch (error) {
      if (mode === 'live' && error instanceof ApiError && error.code === 'CAPABILITY_NOT_CONFIGURED') {
        dispatch({ type: 'liveUnavailable', error: toEnergyError(error) })
        return
      }
      dispatch(failureEvent(error))
    }
  }

  return (
    <div className={`energy energy--${viewport}`} data-viewport={viewport} data-phase={phase}>
      <header className="energy__header">
        <h1>家庭能源计划与仿真</h1>
        <p className="energy__hint">
          全部数据为合成/预测/观测输入，计算由确定性代码完成。模拟收益不等于实际账单；首版只支持
          simulation 执行，live 未配置。
        </p>
      </header>

      {phase === 'ready' ? null : (
        <StatePanel
          phase={phase}
          {...(state.error === undefined ? {} : { error: state.error })}
          {...(phase === 'not_configured' ? { title: '该能力未配置' } : {})}
        />
      )}

      <main className="energy__body">
          <section className="energy__scenario" data-testid="scenario-controls">
            <h3>情景输入（合成）</h3>
            <label className="energy__field">
              ReserveSOC（%）
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                data-testid="backup-requirement"
                value={state.backupRequirementKwh / 10 * 100}
                onChange={(event) => dispatch({ type: 'setBackup', value: Number(event.target.value) / 100 * 10 })}
              />
            </label>
            <label className="energy__field">
              天气情景
              <select
                data-testid="weather-scenario"
                value={state.weatherScenario}
                onChange={(event) => dispatch({ type: 'setWeather', value: event.target.value as WeatherScenario })}
              >
                {WEATHER_SCENARIOS.map((scenario) => (
                  <option key={scenario} value={scenario}>
                    {scenario}
                  </option>
                ))}
              </select>
            </label>
            <div className="energy__buttons">
              <button type="button" data-testid="build-scenario" disabled={state.busy} onClick={() => void buildScenario()}>
                构建情景
              </button>
              <button
                type="button"
                data-testid="request-plan"
                disabled={state.busy || state.scenario === undefined}
                onClick={() => void requestPlan()}
              >
                生成计划
              </button>
            </div>
            {state.scenario === undefined ? null : (
              <div className="energy__scenario-summary" data-testid="scenario-summary">
                <p data-testid="scenario-input-digest">输入摘要：{state.scenario.inputDigest}</p>
                <p data-testid="scenario-mode" data-mode={state.scenario.dataMode}>
                  数据模式：{state.scenario.dataMode} · 时区 {state.scenario.timeZone} · 时隙{' '}
                  {state.scenario.slotMinutes} 分钟 × {state.scenario.slotCount}
                </p>
                <ul className="energy__series">
                  {state.scenario.series.map((series) => (
                    <li key={series.measurementPointRef} data-testid="scenario-series" data-role={series.role}>
                      <Datum
                        label={`${series.role} ${series.measurementPointRef}`}
                        value={series.firstSlotUtc}
                        unit={series.unit}
                        source={`${series.sourceRef.namespace}/${series.sourceRef.sourceId}`}
                        time={`${series.firstSlotUtc} → ${series.lastSlotUtc}`}
                        mode={series.samplingType === 'forecast' ? 'forecast' : series.samplingType === 'simulated' ? 'simulated' : 'observed'}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {phase === 'ready' ? (
            <>
          <section className="energy__versions" data-testid="plan-versions">
            <h3>计划版本（新→旧）</h3>
            {state.versions.length === 0 ? (
              <p data-testid="versions-empty">尚未生成计划。</p>
            ) : (
              [...state.versions].reverse().map((version) => <VersionCard key={version.versionId} version={version} />)
            )}
          </section>

          {state.comparison === undefined ? null : (
            <section className="energy__compare" data-testid="version-compare">
              <h3>版本对比</h3>
              <p data-testid="compare-status">
                状态：{state.comparison.baseStatus} → {state.comparison.compareStatus}
                {state.comparison.statusChanged ? '（已变化）' : '（未变化）'}
              </p>
              <div className="energy__compare-block">
                <h4>约束缺口</h4>
                {state.comparison.constraintGaps.length === 0 ? (
                  <p data-testid="constraint-gap-none">新版本无约束缺口。</p>
                ) : (
                  <ul>
                    {state.comparison.constraintGaps.map((gap, index) => (
                      <li
                        key={`${gap.strategy}-${gap.constraint}-${String(gap.slotIndex)}-${String(index)}`}
                        data-testid="constraint-gap"
                        data-constraint={gap.constraint}
                        data-strategy={gap.strategy}
                        data-slot={gap.slotIndex}
                      >
                        {gap.strategy} · {gap.constraint} @ 时隙 {gap.slotIndex}：{gap.detail}（观测{' '}
                        {formatNumber(gap.observed)} / 限制 {formatNumber(gap.limit)} {gap.unit}）
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="energy__compare-block">
                <h4>来源变化</h4>
                {state.comparison.sourceChanges.length === 0 ? (
                  <p data-testid="source-change-none">新版本来源未变化。</p>
                ) : (
                  <ul>
                    {state.comparison.sourceChanges.map((change) => (
                      <li key={change.field} data-testid="source-change" data-field={change.field}>
                        {change.field}：{change.from} → {change.to}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          <section className="energy__execution" data-testid="execution-controls">
            <h3>模拟执行</h3>
            <div className="energy__buttons">
              <button
                type="button"
                data-testid="request-simulation-execution"
                disabled={state.busy || latest === undefined}
                onClick={() => void requestExecution('simulation')}
              >
                请求模拟执行（mode=simulation）
              </button>
              <button
                type="button"
                data-testid="request-live-execution"
                disabled={state.busy || latest === undefined}
                onClick={() => void requestExecution('live')}
              >
                尝试实机执行（mode=live）
              </button>
            </div>
            {state.execution === undefined ? null : (
              <div className="energy__execution-record" data-testid="execution-record" data-mode={state.execution.mode} data-execution-id={state.execution.executionId}>
                <span className="energy__badge" data-testid="execution-mode" data-mode={state.execution.mode}>
                  {state.execution.mode}
                </span>
                <span data-testid="execution-phase">阶段：{state.execution.phase}</span>
                <span data-testid="execution-device-requests">设备请求：{state.execution.deviceRequestsSent}</span>
                <span data-testid="execution-live-supported">liveSupported：{String(state.execution.liveSupported)}</span>
                {state.execution.finalState === undefined ? null : (
                  <p data-testid="virtual-solix-final-state" data-revision={state.execution.finalState.revision}>
                    Virtual SOLIX 回读：{formatNumber(state.execution.finalState.energyKwh)} kWh · {formatNumber(state.execution.finalState.socPercent, 1)}% SOC · mode=simulation
                  </p>
                )}
                {state.execution.stepRecords === undefined ? null : (
                  <>
                    <p data-testid="execution-step-count">已回读 {state.execution.stepRecords.length} 个 PlanStep 状态快照</p>
                    <ol data-testid="execution-step-records">
                      {state.execution.stepRecords.map((step) => (
                        <li key={step.slotIndex} data-testid="execution-step" data-slot={step.slotIndex}>
                          时隙 {step.slotIndex}：Requested 充电 {formatNumber(step.requested.chargeKw)} kW / 放电 {formatNumber(step.requested.dischargeKw)} kW；
                          状态 {step.statusHistory.join(' → ')}；能量 {formatNumber(step.beforeEnergyKwh)} → {formatNumber(step.afterEnergyKwh)} kWh；
                          状态工件 {step.stateRef.id}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
            {state.liveUnavailable === undefined ? null : (
              <p className="energy__live-unavailable" data-testid="live-unavailable" data-code={state.liveUnavailable.code} role="alert">
                实机执行未配置（{state.liveUnavailable.code}）：{state.liveUnavailable.message}。未调度任何执行，也未发送设备请求。
              </p>
            )}
          </section>

          {state.notice === undefined ? null : (
            <p className="energy__notice" data-testid="energy-notice" role="status">
              {state.notice}
            </p>
          )}
            </>
          ) : null}
      </main>
    </div>
  )
}
