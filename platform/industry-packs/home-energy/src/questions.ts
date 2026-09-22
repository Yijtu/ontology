import type { DataMode } from '@ontology/contracts'

/**
 * Representative questions the `home-energy` pack must be able to answer (SPEC §7,
 * scenario supplement §2/§8). They are declared next to the semantics so the pack can be
 * checked against the concepts each question needs, and so a composition root has a
 * concrete, non-invented question set for its test suite.
 *
 * `dataMode` states the provenance a correct answer must carry (INV-10): a state question
 * is answered from observed or explicitly synthetic data, a forecast question from a
 * forecast series, and a plan question only from a simulation.
 */

export type HomeEnergyQuestionIntent =
  | 'definitions'
  | 'resolve'
  | 'relations'
  | 'rules'
  | 'facts'
  | 'compute'

export interface HomeEnergyRepresentativeQuestion {
  readonly id: string
  readonly question: string
  readonly intent: HomeEnergyQuestionIntent
  readonly expectedConcepts: readonly string[]
  readonly dataMode: DataMode
}

export const HOME_ENERGY_REPRESENTATIVE_QUESTIONS: readonly HomeEnergyRepresentativeQuestion[] = [
  {
    id: 'q-energy-flow',
    question: '当前家庭的能量流是什么？',
    intent: 'facts',
    expectedConcepts: ['site', 'device', 'sensor', 'observation_series'],
    dataMode: 'observed',
  },
  {
    id: 'q-load-coverage',
    question: '总表与子回路是否会重复计入家庭负载？',
    intent: 'relations',
    expectedConcepts: ['load_group', 'sensor'],
    dataMode: 'synthetic',
  },
  {
    id: 'q-tariff',
    question: '峰谷电价时段与购电/上网价格分别是多少？',
    intent: 'definitions',
    expectedConcepts: ['tariff'],
    dataMode: 'synthetic',
  },
  {
    id: 'q-pv-forecast',
    question: '明天光伏发电预测如何？',
    intent: 'facts',
    expectedConcepts: ['forecast_series', 'sensor'],
    dataMode: 'forecast',
  },
  {
    id: 'q-plan',
    question: '在保留指定备用电量的前提下，如何降低明日购电支出？',
    intent: 'compute',
    expectedConcepts: ['energy_plan', 'energy_constraint', 'tariff', 'forecast_series', 'device'],
    dataMode: 'simulation',
  },
  {
    id: 'q-distinguish',
    question: '功率与电量、预测与实测分别是什么，单位是什么？',
    intent: 'definitions',
    expectedConcepts: ['device', 'sensor', 'observation_series', 'forecast_series'],
    dataMode: 'synthetic',
  },
]
