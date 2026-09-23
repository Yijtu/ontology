import type { FewShotExample, FewShotExampleSet, VersionRef } from '@ontology/contracts'
import { HOME_ENERGY_NAMESPACE } from './definitions'

/**
 * The `home-energy` few-shot example set (LOCAL-076; SPEC C3/C4, D7.1; FR-25/26, US-020).
 *
 * These are the pack's own `(question → expected semantic shape)` pairs. They are
 * declaration data only: a question plus concepts/fields/links, never SQL text, a physical
 * column, a customer instance or a credential (INV-03). The pack owns them so every
 * injected example is traceable to `HOME_ENERGY_EXAMPLE_SET_REF`.
 *
 * A composition root materializes the set into the `HOME_ENERGY_EXAMPLE_COLLECTION_REF`
 * keyword-index collection, indexing each example under its `exampleId`. Retrieval then
 * ranks the declared examples with the real BM25 backend and injects only declared pairs.
 */
export const HOME_ENERGY_EXAMPLE_SET_REF: VersionRef = {
  id: 'home-energy.few-shot-examples',
  version: '0.1.0',
  digest: `sha256:${'e'.repeat(64)}`,
}

/** The authorized keyword-index collection the example set is materialized under. */
export const HOME_ENERGY_EXAMPLE_COLLECTION_REF = 'home-energy/examples/few-shot'

export const HOME_ENERGY_FEW_SHOT_EXAMPLES: readonly FewShotExample[] = [
  {
    exampleId: 'a0000000-0000-4000-8000-000000000001',
    question: '峰谷电价时段与购电/上网价格分别是多少？',
    expectedShape: {
      concepts: ['tariff'],
      fields: ['period', 'price_buy', 'price_sell'],
    },
  },
  {
    exampleId: 'a0000000-0000-4000-8000-000000000002',
    question: '明天光伏发电预测如何？',
    expectedShape: {
      concepts: ['forecast_series', 'sensor'],
      fields: ['timestamp', 'forecast_kwh'],
    },
  },
  {
    exampleId: 'a0000000-0000-4000-8000-000000000003',
    question: '总表与子回路是否会重复计入家庭负载？',
    expectedShape: {
      concepts: ['load_group', 'sensor'],
      fields: ['meter_id', 'parent_meter_id'],
    },
  },
  {
    exampleId: 'a0000000-0000-4000-8000-000000000004',
    question: '在保留指定备用电量的前提下，如何降低明日购电支出？',
    expectedShape: {
      concepts: ['energy_plan', 'energy_constraint', 'tariff'],
      fields: ['plan_kwh', 'reserve_kwh', 'price_buy'],
    },
  },
]

/** Build the versioned set the pack exports and a composition root materializes. */
export function buildHomeEnergyExampleSet(): FewShotExampleSet {
  return {
    kind: 'industry_pack_example_set',
    ref: HOME_ENERGY_EXAMPLE_SET_REF,
    namespace: HOME_ENERGY_NAMESPACE,
    collectionRef: HOME_ENERGY_EXAMPLE_COLLECTION_REF,
    examples: [...HOME_ENERGY_FEW_SHOT_EXAMPLES],
  }
}
