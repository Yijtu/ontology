import { useEffect, useReducer, useState } from 'react'
import type { OperationRef } from '@ontology/contracts'
import type { ProfileRef } from '@ontology/contracts'
import { ApiError, type WorkbenchClient } from '../api/client'
import { asPlanResult, WEATHER_SCENARIOS } from '../api/energy'
import type { ForecastIntegrity, PlanCandidateView, ScenarioDescriptor, WeatherScenario } from '../api/energy'
import {
  energyReducer,
  initialEnergyState,
  type EnergyEvent,
  type EnergyPlanVersion,
} from '../state/energy'
import type { WorkbenchError } from '../state/workbench'
import type { EnergyPlanDiffView, EnergyPlanVersionView, EnergyRunExplanationView } from '../api/client'
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
const WEATHER_LABELS: Readonly<Record<WeatherScenario, string>> = {
  anker_base: '上午阴、下午晴',
  afternoon_overcast: '上午阴、下午阴雨',
  sunny: '全天晴',
  overcast: '全天阴',
  storm: '全天暴雨假设',
}

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

function EnergyOverview({ scenario, version, slotIndex, onSlotChange }: {
  readonly scenario: ScenarioDescriptor | undefined
  readonly version: EnergyPlanVersion | undefined
  readonly slotIndex: number
  readonly onSlotChange: (value: number) => void
}) {
  const result = version?.detail.integrityVerified === true && version.result?.status === 'feasible' ? version.result : undefined
  const candidate = result?.candidates.find((entry) => entry.strategy === result.selection.selectedStrategy)
  const interval = candidate?.simulation.intervals.find((entry) => entry.slotIndex === slotIndex)
  const visibleScenario = version?.scenario ?? scenario
  const pvSource = visibleScenario?.series.find((entry) => entry.role === 'pv')?.sourceRef
  const loadSource = visibleScenario?.series.find((entry) => entry.role === 'load')?.sourceRef
  return (
    <section className="energy__overview" data-testid="energy-overview" aria-label="家庭能源总览">
      <div className="energy__overview-head">
        <div>
          <h2>家庭能源总览</h2>
          <p>单户 Virtual SOLIX · 选择时隙查看归档仿真；预测与模拟值分别标注。</p>
        </div>
        <span className="energy__badge" data-mode="simulation">SIMULATION</span>
      </div>
      <div className="energy__flow" role="img" aria-label="家庭能源流：光伏供给家庭并为电池充电，电池和电网供给家庭">
        <svg viewBox="0 0 640 250" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="energy-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0 0L6 3L0 6" fill="#99b8f4" />
            </marker>
          </defs>
          <path className="flow-link" d="M150 62H262V112" />
          <path className="flow-link" d="M150 190H250V150" />
          <path className="flow-link" d="M320 88V104" />
          <path className="flow-link" d="M476 138H392" />
          <rect className="flow-node" x="14" y="26" width="140" height="74" rx="12" />
          <text className="flow-node-title" x="30" y="52">Solar · 光伏</text>
          <text className="flow-node-value" x="30" y="78">{interval === undefined ? '—' : `${formatNumber(interval.pvAvailableKw)} kW`}</text>
          <text className="flow-node-sub" x="30" y="93">forecast</text>
          <rect className="flow-node" x="14" y="154" width="140" height="74" rx="12" />
          <text className="flow-node-title" x="30" y="180">Battery · 储能</text>
          <text className="flow-node-value" x="30" y="206">{visibleScenario === undefined ? '—' : `${formatNumber((interval?.energyEndKwh ?? visibleScenario.initialEnergyKwh) / visibleScenario.batteryCapacityKwh * 100, 1)}%`}</text>
          <text className="flow-node-sub" x="30" y="221">SOC</text>
          <path className="flow-node" d="M292 96l58 42v84h-116v-84z" />
          <path d="M262 106l59-52 59 52" fill="none" stroke="#165dff" strokeWidth="2.5" strokeLinecap="round" />
          <text className="flow-node-title" x="321" y="150" textAnchor="middle">Home</text>
          <text className="flow-node-sub" x="321" y="170" textAnchor="middle">家庭负载</text>
          <text className="flow-node-sub" x="321" y="196" textAnchor="middle">{interval === undefined ? '—' : `${formatNumber(interval.loadKw)} kW`}</text>
          <rect className="flow-node" x="478" y="96" width="148" height="74" rx="12" />
          <text className="flow-node-title" x="494" y="122">Grid · 电网</text>
          <text className="flow-node-value" x="494" y="148">{interval === undefined ? '—' : `${formatNumber(interval.gridImportKw)} kW`}</text>
          <text className="flow-node-sub" x="494" y="163">simulated</text>
        </svg>
        <div className="energy__flow-legend">
          <span>能源关系示意 · 非实时功率流</span>
          <span>数值来自同一已归档计划的时隙结果</span>
        </div>
      </div>
      {visibleScenario === undefined ? <p>先构建情景，随后生成计划查看 Solar、Battery、Grid 和 HomeLoad。</p> : (
        <>
          <label className="energy__overview-timeline">
            查看时隙 {slotIndex + 1} / {visibleScenario.slotCount}
            <input type="range" min={0} max={visibleScenario.slotCount - 1} value={slotIndex} disabled={candidate?.simulation.intervals.length === 0 || candidate === undefined} onChange={(event) => onSlotChange(Number(event.target.value))} data-testid="energy-slot-picker" />
          </label>
          <div className="energy__overview-grid">
            <article className="energy__overview-card" data-testid="overview-solar">
              <h3>Solar · 光伏</h3>
              {interval === undefined ? <p>等待计划预测</p> : <Datum label="光伏可用功率" value={formatNumber(interval.pvAvailableKw)} unit="kW" source={`${pvSource?.namespace ?? 'home-energy'}/${pvSource?.sourceId ?? 'synthetic'} · ${visibleScenario.inputRef.id}`} time={interval.startUtc} mode="forecast" />}
            </article>
            <article className="energy__overview-card" data-testid="overview-battery">
              <h3>Battery · 储能</h3>
              {interval === undefined ? <Datum label="场景初始 SOC" value={formatNumber(visibleScenario.initialSocPercent, 1)} unit="%" source={visibleScenario.inputRef.id} time={visibleScenario.horizon.start} mode="synthetic" /> : <Datum label="时隙末 SOC" value={formatNumber(interval.energyEndKwh / visibleScenario.batteryCapacityKwh * 100, 1)} unit="%" source={candidate?.planRef.id ?? visibleScenario.inputRef.id} time={interval.endUtc} mode="simulated" />}
            </article>
            <article className="energy__overview-card" data-testid="overview-grid">
              <h3>Grid · 电网</h3>
              {interval === undefined ? <p>等待计划仿真</p> : <Datum label="购电功率" value={formatNumber(interval.gridImportKw)} unit="kW" source={candidate?.planRef.id ?? visibleScenario.inputRef.id} time={interval.startUtc} mode="simulated" />}
            </article>
            <article className="energy__overview-card" data-testid="overview-load">
              <h3>HomeLoad · 家庭负荷</h3>
              {interval === undefined ? <p>等待计划输入</p> : <Datum label="负荷功率" value={formatNumber(interval.loadKw)} unit="kW" source={`${loadSource?.namespace ?? 'home-energy'}/${loadSource?.sourceId ?? 'synthetic'} · ${visibleScenario.inputRef.id}`} time={interval.startUtc} mode="synthetic" />}
            </article>
          </div>
          {interval === undefined ? <p className="energy__overview-foot">尚无该时隙的可行、完整计划；这里不填预设功率值。</p> : <p className="energy__overview-foot">所示功率和 SOC 来自同一已归档计划的时隙结果；不代表真实设备读数或实际账单。</p>}
        </>
      )}
    </section>
  )
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
  if (candidate.simulation.status !== 'feasible') {
    return (
      <li className="energy__candidate" data-testid="plan-candidate" data-strategy={candidate.strategy}>
        <span className="energy__candidate-name" data-testid="candidate-strategy">{candidate.strategy}</span>
        <p role="status" data-testid="candidate-gap">候选状态：{candidate.simulation.status}；不展示未成立的费用或收益。</p>
        {candidate.simulation.missingInputs.length === 0 ? null : (
          <ul data-testid="candidate-missing-inputs">
            {candidate.simulation.missingInputs.map((entry, index) => <li key={`${entry.reason}-${String(index)}`}>{entry.reason}：{entry.detail}</li>)}
          </ul>
        )}
        {candidate.simulation.violations.length === 0 ? null : (
          <ul data-testid="candidate-violations">
            {candidate.simulation.violations.map((entry, index) => <li key={`${entry.constraint}-${String(entry.slotIndex)}-${String(index)}`}>{entry.constraint} @ 时隙 {entry.slotIndex}：{entry.detail}</li>)}
          </ul>
        )}
      </li>
    )
  }
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
  const [savedVersions, setSavedVersions] = useState<readonly EnergyPlanVersionView[]>([])
  const [historyTruncated, setHistoryTruncated] = useState(false)
  const [latestDiff, setLatestDiff] = useState<EnergyPlanDiffView | undefined>()
  const [a4Explanation, setA4Explanation] = useState<{ readonly data?: EnergyRunExplanationView; readonly error?: string } | undefined>()
  const [selectedSlot, setSelectedSlot] = useState(48)
  const [forecastIntegrity, setForecastIntegrity] = useState<ForecastIntegrity>('complete')
  const phase = state.phase
  const latest = state.versions[state.versions.length - 1]

  useEffect(() => {
    if (!publishedExecutionRequired) return
    let cancelled = false
    void client.getEnergyPlanVersions().then((result) => {
      if (cancelled) return
      setSavedVersions(result.versions)
      setHistoryTruncated(result.historyTruncated)
      if (result.selected !== undefined) void client.getEnergyRunExplanation(result.selected.runId).then((data) => { if (!cancelled) setA4Explanation({ data }) }).catch((error: unknown) => { if (!cancelled) setA4Explanation({ error: error instanceof ApiError ? error.code : 'ENERGY_EXPLANATION_UNAVAILABLE' }) })
      if (result.selected?.parentPlanRef !== undefined) void client.getEnergyPlanDiff(result.selected.parentPlanRef, result.selected.planRef).then((diff) => { if (!cancelled) setLatestDiff(diff) }).catch(() => undefined)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [client, publishedExecutionRequired])

  const buildScenario = async () => {
    dispatch({ type: 'busy' })
    try {
      const scenario = await client.buildEnergyScenario({
        reserveSocPercent: state.backupRequirementKwh / 10 * 100,
        reserveWindowStartSlot: state.reserveWindowStartSlot,
        weatherScenario: state.weatherScenario,
        forecastIntegrity,
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
      if (planResult === undefined) throw new Error('仿真结果无法识别，无法选择或比较计划。')
      const previewRef = planResult === undefined ? undefined : (planResult.selection.selectedStrategy === undefined
        ? planResult.candidates[0]?.planRef ?? planResult.baseline?.planRef
        : planResult.candidates.find((candidate) => candidate.strategy === planResult.selection.selectedStrategy)?.planRef ?? planResult.baseline?.planRef)
      const version: EnergyPlanVersion = {
        versionId: detail.scenario.inputDigest,
        scenario: detail.scenario,
        record,
        detail,
        result: planResult,
        publishedRunId: '',
        ...(previewRef === undefined ? {} : { executionPlanRef: previewRef }),
        executionInputRefs: record.inputRefs,
      }
      let officialRunId = ''
      let executionPlanRef = version.executionPlanRef
      let planDiff: EnergyPlanDiffView | undefined
      let comparisonLimitation: string | undefined
      if (publishedExecutionRequired && planResult.status !== 'feasible') {
        dispatch({ type: 'planLoaded', version: { ...version, selectedStatus: 'Unselected' } })
        const missing = planResult.missingInputs
        dispatch({ type: 'notice', message: missing.length > 0
          ? `预测/输入不完整，未替换当前选中版本：${missing[0]?.detail ?? '请刷新来源并重试。'}`
          : '新计划未通过硬约束校验，未替换当前选中版本；请查看具体时段缺口。' })
        return
      }
      if (publishedExecutionRequired) {
      const officialRun = await client.createRun({
        profileRef,
        question: '为家庭储能能源系统生成满足备电目标的确定性充放电计划。',
        context: { timeZone: 'Asia/Shanghai', taskId: 'energy.plan-candidate', taskInput: { siteRef: 'virtual-solix-1', scenarioRef: JSON.stringify(scenario.inputRef), ...(scenario.parentPlanRef === undefined ? {} : { parentPlanRef: JSON.stringify(scenario.parentPlanRef) }), backupRequirementKwh: state.backupRequirementKwh, reserveWindowStartSlot: state.reserveWindowStartSlot, weatherScenario: state.weatherScenario } },
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
      if (authorizedPlan.stateRevision !== scenario.stateRevision || authorizedPlan.parentPlanRef?.digest !== scenario.parentPlanRef?.digest) throw new Error('正式计划状态版本或父计划与情景不一致；保留当前选中计划。')
      await client.selectEnergyPlan(officialRun.runId)
      const history = await client.getEnergyPlanVersions()
      setSavedVersions(history.versions)
      setHistoryTruncated(history.historyTruncated)
      try { setA4Explanation({ data: await client.getEnergyRunExplanation(officialRun.runId) }) }
      catch (error) { setA4Explanation({ error: error instanceof ApiError ? error.code : 'ENERGY_EXPLANATION_UNAVAILABLE' }) }
      if (authorizedPlan.parentPlanRef !== undefined) {
        try {
          planDiff = await client.getEnergyPlanDiff(authorizedPlan.parentPlanRef, authorizedPlan.selectedPlanRef)
          setLatestDiff(planDiff)
        } catch (error) {
          // Only a known horizon/state incompatibility is a non-fatal comparison gap.
          // A missing version or broken parent link is a lineage integrity failure.
          if (!(error instanceof ApiError) || error.code !== 'PLAN_DIFF_NOT_COMPARABLE' || error.status !== 409) throw error
          comparisonLimitation = `新计划已选中，但父版与新版本差异不可比（${error.code}）；不展示跨时间窗或状态版本的因果成本差。`
          setLatestDiff(undefined)
        }
      } else setLatestDiff(undefined)
      officialRunId = officialRun.runId
      executionPlanRef = authorizedPlan.selectedPlanRef
      }
      dispatch({ type: 'planLoaded', version: { ...version, publishedRunId: officialRunId, ...(executionPlanRef === undefined ? {} : { executionPlanRef }), ...(planDiff === undefined ? {} : { planDiff }), selectedStatus: publishedExecutionRequired ? 'Selected' : 'Unselected' } })
      if (comparisonLimitation !== undefined) dispatch({ type: 'notice', message: comparisonLimitation })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const requestExecution = async (mode: 'simulation' | 'live') => {
    if (latest === undefined) return
      const planRef = selectedPlanRef(latest)
    if (planRef === undefined || latest.executionPlanRef === undefined || (publishedExecutionRequired && latest.publishedRunId.length === 0)) {
      dispatch({ type: 'notice', message: '当前没有与正式核验答案绑定的可执行计划。' })
      return
    }
    dispatch({ type: 'busy' })
    try {
      const execution = await client.requestExecution({
        runId: latest.publishedRunId || globalThis.crypto.randomUUID(),
        expectedStateRevision: latest.scenario.stateRevision,
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

  const dashboardResult =
    latest?.detail.integrityVerified === true && latest.result?.status === 'feasible' ? latest.result : undefined
  const dashboardCandidate = dashboardResult?.candidates.find(
    (entry) => entry.strategy === dashboardResult.selection.selectedStrategy,
  )
  const dashboardInterval = dashboardCandidate?.simulation.intervals.find((entry) => entry.slotIndex === selectedSlot)
  const dashboardSoc =
    dashboardInterval === undefined
      ? state.scenario?.initialSocPercent ?? latest?.scenario.initialSocPercent
      : latest?.scenario.batteryCapacityKwh === undefined || latest.scenario.batteryCapacityKwh === 0
        ? undefined
        : (dashboardInterval.energyEndKwh / latest.scenario.batteryCapacityKwh) * 100
  const reservePercent = (state.backupRequirementKwh / 10) * 100
  const declaredRelations = a4Explanation?.data?.definition.declaredRelations.length
  const planCost = dashboardCandidate?.objective.netCost
  const activeScenario =
    forecastIntegrity === 'expired'
      ? 'D'
      : state.backupRequirementKwh === 6
        ? 'C'
        : state.weatherScenario === 'afternoon_overcast'
          ? 'B'
          : state.weatherScenario === 'anker_base' && forecastIntegrity === 'complete'
            ? 'A'
            : undefined

  return (
    <div className={`energy energy--${viewport}`} data-viewport={viewport} data-phase={phase}>
      <header className="energy__header">
        <div className="energy__eyebrow">HOME ENERGY / DIGITAL TWIN</div>
        <h1>家庭能源计划与仿真</h1>
        <p className="energy__hint">
          全部数据为合成/预测/观测输入，计算由确定性代码完成。模拟收益不等于实际账单；首版只支持
          simulation 执行，live 未配置。
        </p>
      </header>

      <div className="energy__metrics">
        <article className="energy-metric" data-testid="metric-soc">
          <div className="energy-metric__top"><span>电池 SOC</span></div>
          <div className="energy-metric__value">
            {dashboardSoc === undefined ? '—' : formatNumber(dashboardSoc, 1)}<em>%</em>
          </div>
          <small>时隙 {selectedSlot} / {state.scenario?.slotCount ?? 96} · 模拟</small>
        </article>
        <article className="energy-metric" data-testid="metric-reserve">
          <div className="energy-metric__top"><span>备用电下限</span></div>
          <div className="energy-metric__value">{formatNumber(reservePercent, 0)}<em>%</em></div>
          <small>ReserveSOC 用户设定</small>
        </article>
        <article className="energy-metric" data-testid="metric-relations">
          <div className="energy-metric__top"><span>本体关系</span></div>
          <div className="energy-metric__value">{declaredRelations ?? '—'}</div>
          <small>已声明的实例关系</small>
        </article>
        <article className="energy-metric" data-testid="metric-cost">
          <div className="energy-metric__top"><span>计划净成本</span></div>
          <div className="energy-metric__value">
            {planCost === undefined ? '—' : formatNumber(planCost, 2)}<em>CNY</em>
          </div>
          <small>同条件仿真 · 非实际账单</small>
        </article>
      </div>

      {phase === 'ready' ? null : (
        <StatePanel
          phase={phase}
          {...(phase === 'not_configured'
            ? { title: '该能力未配置' }
            : phase === 'empty'
              ? { title: '尚未构建情景' }
              : {})}
          {...(state.error === undefined ? {} : { error: state.error })}
        />
      )}

      <main className="energy__body">
          <EnergyOverview scenario={state.scenario} version={latest} slotIndex={selectedSlot} onSlotChange={setSelectedSlot} />

          <section className="energy__insight" data-testid="energy-insight">
            <h3>为什么这样安排</h3>
            <p className="energy__insight-lead">
              优先满足 <b>备用电约束</b>，再结合天气与分时电价安排充放电；规则约束优先于费用目标。
            </p>
            <ul className="energy__insight-checks">
              <li>预测、计划和执行回执分开展示，模拟值不与实测混淆。</li>
              <li>天气或备电要求变化后，重新校验并生成新版本计划，旧计划标记 Superseded。</li>
              <li>预测过期或缺失时停止计划推进，不产生可执行成功。</li>
            </ul>
            <p className="energy__insight-note">
              界面预演 PRD 中的业务状态；成本与 SOC 由确定性代码计算，不代表真实账单或设备读数。
            </p>
          </section>

          <section className="energy__scenario-cards" data-testid="energy-scenario-cards" aria-label="验证场景">
            <button
              type="button"
              className="scenario-card"
              data-scene="A"
              data-active={activeScenario === 'A'}
              onClick={() => { dispatch({ type: 'setWeather', value: 'anker_base' }); dispatch({ type: 'setBackup', value: 2 }); dispatch({ type: 'setReserveWindow', value: 0 }); setForecastIntegrity('complete') }}
            >
              <span className="scenario-card__index">场景 A</span>
              <h4>正常一天</h4>
              <p>上午阴、下午晴；ReserveSOC 20%。</p>
              <span className="scenario-card__foot">省钱目标 · 默认</span>
            </button>
            <button
              type="button"
              className="scenario-card"
              data-scene="B"
              data-active={activeScenario === 'B'}
              onClick={() => { dispatch({ type: 'setWeather', value: 'afternoon_overcast' }); setForecastIntegrity('complete') }}
            >
              <span className="scenario-card__index">场景 B</span>
              <h4>天气变化</h4>
              <p>下午转阴雨，光伏预测下调后重规划。</p>
              <span className="scenario-card__foot">Weather → Solar → Battery</span>
            </button>
            <button
              type="button"
              className="scenario-card"
              data-scene="C"
              data-active={activeScenario === 'C'}
              onClick={() => { dispatch({ type: 'setBackup', value: 6 }); dispatch({ type: 'setReserveWindow', value: 68 }); setForecastIntegrity('complete') }}
            >
              <span className="scenario-card__index">场景 C</span>
              <h4>提高备电</h4>
              <p>ReserveSOC 20% → 60%，晚间 17:00 起保底。</p>
              <span className="scenario-card__foot">用户约束 · 目标冲突</span>
            </button>
            <button
              type="button"
              className="scenario-card"
              data-scene="D"
              data-active={activeScenario === 'D'}
              onClick={() => { setForecastIntegrity('expired') }}
            >
              <span className="scenario-card__index">场景 D</span>
              <h4>预测数据过期</h4>
              <p>有效期不足，暂停计划推进并给出恢复建议。</p>
              <span className="scenario-card__foot">异常边界 · 不执行</span>
            </button>
          </section>

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
                    {WEATHER_LABELS[scenario]}
                  </option>
                ))}
              </select>
            </label>
            <label className="energy__field">
              备电目标生效窗口
              <select data-testid="reserve-window" value={state.reserveWindowStartSlot} onChange={(event) => dispatch({ type: 'setReserveWindow', value: Number(event.target.value) })}>
                <option value={0}>全天最低保底</option>
                <option value={68}>晚间 17:00 起保底</option>
              </select>
            </label>
            <label className="energy__field">
              预测数据（故障注入）
              <select data-testid="forecast-integrity" value={forecastIntegrity} onChange={(event) => setForecastIntegrity(event.target.value as ForecastIntegrity)}>
                <option value="complete">完整有效</option>
                <option value="expired">有效期不足</option>
                <option value="missing">下午预测缺失</option>
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
                <p data-testid="scenario-start-state">Virtual SOLIX 起始状态：{formatNumber(state.scenario.initialEnergyKwh)} kWh · {formatNumber(state.scenario.initialSocPercent, 1)}% SOC · revision {state.scenario.stateRevision}</p>
                <p data-testid="scenario-reserve-window">ReserveSOC {formatNumber(state.scenario.reserveSocPercent, 1)}% 生效时隙：{state.scenario.reserveWindowStartSlot} → 96</p>
                <p data-testid="scenario-forecast-integrity">预测数据：{state.scenario.forecastIntegrity}（合成故障注入，不是实时来源）</p>
                <p data-testid="scenario-parent-plan">父计划：{state.scenario.parentPlanRef?.id ?? '首版场景'}</p>
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

          {savedVersions.length === 0 ? null : (
            <section className="energy__versions" data-testid="persisted-plan-versions">
              <h3>已保存计划版本</h3>
              {historyTruncated ? <p role="status" data-testid="plan-history-truncated">这里只展示最近 100 个版本；更早版本未包含在本页。</p> : null}
              <ol>
                {savedVersions.map((saved) => (
                  <li key={saved.versionId} data-testid="persisted-plan-version" data-status={saved.status}>
                    <span>{saved.status} · {saved.detail.weatherScenario} · ReserveSOC {formatNumber(saved.detail.reserveSocPercent, 1)}%（slot {saved.detail.reserveWindowStartSlot} 起）· 起始SOC {formatNumber(saved.detail.initialSocPercent, 1)}% · 成本 {formatNumber(saved.detail.candidateTotalCost)} CNY · plan {saved.planRef.id}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {a4Explanation === undefined ? null : (
            <section className="energy__versions" data-testid="energy-a4-explanation" data-status={a4Explanation.data?.status ?? 'unavailable'}>
              <h3>本体解释与本次运行证据</h3>
              {a4Explanation.error === undefined ? null : <p role="status" data-testid="energy-a4-error">解释读取失败：{a4Explanation.error}</p>}
              {a4Explanation.data === undefined ? null : (
                <>
                  <p data-testid="energy-a4-status">{a4Explanation.data.status === 'verified' ? '已确认实例关系与本次运行工件完整绑定' : '关系链未完整确认；以下计算数值不构成本体因果解释'}</p>
                  <p>行业定义 {a4Explanation.data.definition.ref.id}@{a4Explanation.data.definition.ref.version} · digest {a4Explanation.data.definition.ref.digest}</p>
                  <p>定义关系：{a4Explanation.data.definition.declaredRelations.join(' → ')}</p>
                  {a4Explanation.data.instancePath.length === 0 ? <p data-testid="energy-a4-no-instance-path">没有可用于本次场景的已确认实例关系。</p> : (
                    <ol data-testid="energy-a4-instance-path">
                      {a4Explanation.data.instancePath.map((hop) => <li key={hop.statementId}>{hop.relationId} · statement {hop.statementId}@{hop.statementVersion} · {hop.fromEntityId} → {hop.toEntityId} · 来源 {hop.sourceRefs.map((ref) => `${ref.id}:${ref.digest}`).join(', ')}</li>)}
                    </ol>
                  )}
                  <p data-testid="energy-a4-run-evidence">scenario {a4Explanation.data.runEvidence.scenarioRef.id}:{a4Explanation.data.runEvidence.scenarioRef.digest} · 输入清单 {a4Explanation.data.runEvidence.inputManifestHash} · SOC 来源 {a4Explanation.data.runEvidence.sourceEvidenceRef.id}:{a4Explanation.data.runEvidence.sourceEvidenceRef.digest} · 计算结果 {a4Explanation.data.runEvidence.resultRef.id}:{a4Explanation.data.runEvidence.resultRef.digest} · plan {a4Explanation.data.runEvidence.selectedPlanRef.id}:{a4Explanation.data.runEvidence.selectedPlanRef.digest}</p>
                  <p>本次输入 {a4Explanation.data.runEvidence.weatherScenario} · {a4Explanation.data.runEvidence.horizon.startUtc} → {a4Explanation.data.runEvidence.horizon.endUtc} · ReserveSOC {formatNumber(a4Explanation.data.runEvidence.reserveSocPercent, 1)}%（slot {a4Explanation.data.runEvidence.reserveWindowStartSlot} 起）· state revision {a4Explanation.data.runEvidence.stateRevision}</p>
                  <p data-testid="energy-a4-computation">确定性预测/计划工件：PV {formatNumber(a4Explanation.data.runEvidence.forecastPvKwh)} kWh · 计划成本 {formatNumber(a4Explanation.data.runEvidence.candidateTotalCost)} CNY · reserve {a4Explanation.data.runEvidence.reserveSatisfied ? '满足' : '不满足'}</p>
                  <ul data-testid="energy-a4-constraints">{a4Explanation.data.runEvidence.reserveMargins.map((margin) => <li key={`${margin.windowStartSlot}-${margin.windowEndSlot}`}>ReserveSOC {formatNumber(margin.reserveKwh)} kWh · slot {margin.windowStartSlot} → {margin.windowEndSlot} · margin {formatNumber(margin.marginKwh)} kWh · {margin.satisfied ? '满足' : '缺口'}</li>)}</ul>
                  {a4Explanation.data.gaps.length === 0 ? null : <ul data-testid="energy-a4-gaps">{a4Explanation.data.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
                  <p>发布 revision {a4Explanation.data.publicationRevision} · 当前解释状态：{a4Explanation.data.status}</p>
                </>
              )}
            </section>
          )}

          {phase === 'ready' ? (
            <>
          <section className="energy__versions" data-testid="plan-versions">
            <h3>计划版本（新→旧）</h3>
            {latestDiff === undefined ? null : (
              <section data-testid="persisted-plan-diff">
                <h4>本次重规划差异（由归档输入与计划计算）</h4>
                {'weatherBefore' in latestDiff.inputChanges ? <p data-testid="diff-weather">天气：{String(latestDiff.inputChanges['weatherBefore'])} → {String(latestDiff.inputChanges['weatherAfter'])}</p> : null}
                {'reserveSocBefore' in latestDiff.inputChanges ? <p data-testid="diff-reserve">ReserveSOC：{String(latestDiff.inputChanges['reserveSocBefore'])}% → {String(latestDiff.inputChanges['reserveSocAfter'])}%</p> : null}
                {'reserveWindowBefore' in latestDiff.inputChanges ? <p data-testid="diff-reserve-window">备电生效窗口：slot {String(latestDiff.inputChanges['reserveWindowBefore'])} → slot {String(latestDiff.inputChanges['reserveWindowAfter'])}</p> : null}
                <p data-testid="diff-pv">PV 预测：{formatNumber(latestDiff.forecast.pvBeforeKwh)} → {formatNumber(latestDiff.forecast.pvAfterKwh)} kWh（Δ {formatNumber(latestDiff.forecast.pvDeltaKwh)} kWh）</p>
                <p data-testid="diff-cost">计划净成本：{formatNumber(latestDiff.result.costBefore)} → {formatNumber(latestDiff.result.costAfter)} CNY（Δ {formatNumber(latestDiff.result.costDelta)} CNY）</p>
                <p data-testid="diff-affected-slots">SOC/动作受影响时隙：{latestDiff.affectedIntervals.length}</p>
                <ul data-testid="diff-evidence-refs">{latestDiff.evidenceRefs.map((ref) => <li key={ref.id}>{ref.id} · {ref.digest}</li>)}</ul>
                <ol data-testid="diff-cause-trace">{latestDiff.causeTrace.map((entry, index) => <li key={`${String(entry['stage'])}-${index}`}>{String(entry['stage'])} · 证据 {String((entry['evidence'] as { id?: unknown } | undefined)?.id ?? (entry['scenarioEvidence'] as { id?: unknown } | undefined)?.id ?? '')}</li>)}</ol>
                {latestDiff.limitations.map((item) => <p key={item} className="energy__notice">{item}</p>)}
              </section>
            )}
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
                disabled={state.busy || latest === undefined || latest.publishedRunId.length === 0}
                onClick={() => void requestExecution('simulation')}
              >
                请求模拟执行（mode=simulation）
              </button>
              <button
                type="button"
                data-testid="request-live-execution"
                disabled={state.busy || latest === undefined || latest.publishedRunId.length === 0}
                onClick={() => void requestExecution('live')}
              >
                尝试实机执行（mode=live）
              </button>
            </div>
            {latest !== undefined && latest.publishedRunId.length === 0 ? (
              <p data-testid="execution-unavailable">当前仅为直接计算预览；需要正式 run 发布并核验同一计划后才能模拟执行。</p>
            ) : null}
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
