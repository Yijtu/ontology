import { beforeAll, describe, expectTypeOf, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type { Capability, ForecastPort } from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, validator } from './helpers'

const DIGEST = `sha256:${'a'.repeat(64)}`
const TS = '2026-01-01T01:00:00Z'

const entityRef = {
  id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  version: '1.0.0',
  digest: DIGEST,
  kind: 'source',
}
const versionRef = { id: 'home-energy.forecast.persistence', version: '1.0.0', digest: DIGEST }

let ajv: Ajv2020
const v = (file: string, defName: string): ValidateFunction => validator(ajv, file, defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('ForecastPort contract (SPEC E1, C3)', () => {
  const request = {
    entityRef,
    metric: 'power',
    targetWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
    asOf: TS,
    expectedUnit: 'kW',
    maxPoints: 96,
  }

  const response = {
    entityRef,
    metric: 'power',
    unit: 'kW',
    issuedAt: '2026-01-01T00:00:00Z',
    targetWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
    method: 'persistence',
    assumptions: ['clear-sky'],
    modelVersion: versionRef,
    points: [
      { targetTime: '2026-01-01T00:00:00Z', value: { amount: '4.0', unit: 'kW' }, quality: 'good' },
      { targetTime: '2026-01-01T00:15:00Z', quality: 'missing' },
    ],
    quality: 'good',
    snapshot: {
      sourceRef: { namespace: 'home-energy', sourceId: 'synthetic-forecast' },
      schemaVersion: '1.0.0',
      readAt: TS,
      asOf: '2026-01-01T00:00:00Z',
      consistency: 'read_time',
      resultDigest: DIGEST,
    },
    completeness: 'complete',
  }

  it('accepts a bounded forecast read request and response', () => {
    expectValid(v('data.schema.json', 'ForecastReadRequest'), request, 'forecast read request')
    expectValid(v('data.schema.json', 'ForecastReadResponse'), response, 'forecast read response')
  })

  it('requires the as-of bound so a historical read can never ask for the future', () => {
    const validate = v('data.schema.json', 'ForecastReadRequest')
    const withoutAsOf = {
      entityRef: request.entityRef,
      metric: request.metric,
      targetWindow: request.targetWindow,
    }
    expectInvalid(validate, withoutAsOf, 'forecast read without asOf')
    expectInvalid(validate, { ...request, targetWindow: undefined }, 'forecast read without target window')
    expectInvalid(validate, { ...request, consistency: 'read_time' }, 'unknown request field')
  })

  it('preserves issue time, validity window and model version on the result', () => {
    const validate = v('data.schema.json', 'ForecastReadResponse')
    expectInvalid(validate, { ...response, issuedAt: undefined }, 'result without issue time')
    expectInvalid(validate, { ...response, targetWindow: undefined }, 'result without validity window')
    expectInvalid(validate, { ...response, modelVersion: undefined }, 'result without a model version')
    expectInvalid(validate, { ...response, method: '' }, 'result with an empty method')
  })

  it('carries a SourceSnapshot with a declared consistency level', () => {
    const validate = v('data.schema.json', 'ForecastReadResponse')
    expectValid(
      validate,
      { ...response, snapshot: { ...response.snapshot, consistency: 'immutable' } },
      'immutable forecast snapshot',
    )
    expectInvalid(
      validate,
      { ...response, snapshot: { ...response.snapshot, consistency: 'serializable' } },
      'undeclared consistency',
    )
    expectInvalid(validate, { ...response, snapshot: undefined }, 'missing source snapshot')
  })

  it('keeps target time distinct from issue time on every forecast point', () => {
    const validate = v('data.schema.json', 'ForecastPoint')
    expectValid(
      validate,
      { targetTime: '2026-01-01T00:00:00Z', value: { amount: '4.0', unit: 'kW' }, quality: 'good' },
      'forecast point',
    )
    expectInvalid(validate, { timestamp: TS, quality: 'good' }, 'observation-shaped forecast point')
  })

  it('exposes the port as a read method plus a declared capability', () => {
    expectTypeOf<ForecastPort>().toHaveProperty('readForecast')
    expectTypeOf<ForecastPort>().toHaveProperty('capability')
    expectTypeOf<ForecastPort['capability']>().toEqualTypeOf<Capability>()
  })
})
