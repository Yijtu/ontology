import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import {
  MODELLING_PARAMETER_EVAL_SET,
  evalSetProjection,
} from '../evaluation/modelling/fixed-set'
import { runModellingParameterEvaluation } from '../evaluation/modelling/modelling-eval'
import {
  assertReadinessHonest,
  buildControlledVerification,
  buildReadinessReport,
} from '../evaluation/modelling/readiness-report'
import type { CaseEvaluation } from '../evaluation/modelling/scoring'

/**
 * V03-046: the fixed modelling / parameter-extraction evaluation set and model readiness
 * report. The controlled run proves the harness mechanism only; real-model quality is
 * reported separately and is `not_verified` without an authorized endpoint.
 */

function caseOf(cases: readonly CaseEvaluation[], caseId: string): CaseEvaluation {
  const found = cases.find((entry) => entry.caseId === caseId)
  if (found === undefined) throw new Error(`case ${caseId} was not evaluated`)
  return found
}

describe('fixed modelling/parameter-extraction evaluation set', () => {
  it('is a fixed set of authored cases with a stable digest', () => {
    expect(MODELLING_PARAMETER_EVAL_SET.length).toBe(6)
    const ids = MODELLING_PARAMETER_EVAL_SET.map((entry) => entry.caseId)
    expect(new Set(ids).size).toBe(ids.length)
    // Every case carries a non-empty independent oracle and a fixed source text.
    for (const entry of MODELLING_PARAMETER_EVAL_SET) {
      expect(entry.sourceText.length).toBeGreaterThan(0)
      expect(entry.reference.length).toBeGreaterThan(0)
    }
  })

  it('derives the reference-set digest from the fixed inputs and oracle, never from a run', () => {
    const expectedDigest = sha256DigestOf(canonicalJson(evalSetProjection(MODELLING_PARAMETER_EVAL_SET)))
    const projectionAgain = evalSetProjection([...MODELLING_PARAMETER_EVAL_SET])
    expect(sha256DigestOf(canonicalJson(projectionAgain))).toBe(expectedDigest)
  })
})

describe('controlled/loopback evaluation proves the harness mechanism', () => {
  it('classifies every fixed case exactly as the independently authored expectation', async () => {
    const result = await runModellingParameterEvaluation()
    expect(result.controlled.summary.cases).toBe(MODELLING_PARAMETER_EVAL_SET.length)
    expect(result.controlled.summary.failed).toBe(0)
    expect(result.controlled.summary.passed).toBe(result.controlled.summary.cases)
    // A controlled run can only ever claim the mechanism, never model quality.
    expect(result.controlled.proves).toBe('mechanism_only')
  })

  it('detects a wrong value, an omission and a fabricated item (modelling)', async () => {
    const result = await runModellingParameterEvaluation()
    const faults = caseOf(result.cases, 'modelling-faults-detected')
    expect(faults.errors).toEqual([
      { key: 'attribute:rated_power', field: 'unit', expected: 'kW', observed: 'W' },
    ])
    expect(faults.missing).toEqual(['attribute:device_kind'])
    expect(faults.unexpected).toEqual(['attribute:device_serial', 'object:phantom'])
    expect(faults.requiredCorrections).toContain('correct attribute:rated_power.unit: expected kW, observed W')
  })

  it('detects a lost decimal precision and a dropped parameter (parameter extraction)', async () => {
    const result = await runModellingParameterEvaluation()
    const precision = caseOf(result.cases, 'parameter-precision-and-omission')
    expect(precision.errors).toEqual([
      { key: 'attribute:device.rated_power', field: 'value', expected: '5.55', observed: '5.6' },
    ])
    expect(precision.missing).toEqual(['attribute:device.device_name'])
    expect(precision.unexpected).toEqual([])
  })

  it('surfaces an unresolved unit/terminology overlap for human review (disambiguation)', async () => {
    const result = await runModellingParameterEvaluation()
    const disambiguation = caseOf(result.cases, 'modelling-disambiguation')
    expect(disambiguation.disambiguation).toEqual([
      'terminology_mismatch:the mounted asset names "device" as "Mounted Device", not "Device"',
      'unit_conflict:mounted unit is W',
    ])
    const unitConflict = caseOf(result.cases, 'parameter-unit-conflict')
    expect(unitConflict.disambiguation).toEqual(['UNIT_MISMATCH:attribute rated_power expects unit kW'])
    expect(unitConflict.errors).toEqual([
      { key: 'attribute:device.rated_power', field: 'unit', expected: 'kW', observed: 'W' },
    ])
  })
})

describe('model readiness report keeps controlled and real-model quality separate', () => {
  it('marks real-model quality not_verified when no endpoint/budget is available', async () => {
    const result = await runModellingParameterEvaluation()
    const report = result.report
    expect(report.schemaVersion).toBe('ontology.model-readiness@1')
    expect(report.realModel.status).toBe('not_verified')
    expect(report.realModel.referenceSetDigest).toBe(report.evalSetDigest)
    expect(report.realModel.reason).toContain('controlled')
    // No real result may be promoted from the controlled run.
    expect(report.realModel.candidateErrors).toEqual([])
    expect(report.realModel.omissions).toEqual([])
    expect(report.realModel.disambiguation).toEqual([])
    expect(report.realModel.humanCorrections).toEqual([])
    expect(report.realModel.evidence).toEqual([])
    // The controlled section is where the (mechanism-only) defects live.
    expect(report.controlled.candidateErrors.length).toBeGreaterThan(0)
    expect(report.controlled.proves).toBe('mechanism_only')
    expect(report.notes.some((note) => note.includes('separately'))).toBe(true)
  })

  it('records a real run only with evidence and rejects a reference-set mismatch', () => {
    const controlled = buildControlledVerification('sha256:' + '0'.repeat(64), [], 0)
    const realCase: CaseEvaluation = {
      caseId: 'modelling-equipment-catalog',
      family: 'modelling',
      matched: ['object:device'],
      missing: [],
      errors: [],
      unexpected: [],
      disambiguation: [],
      requiredCorrections: [],
    }
    const report = buildReadinessReport({
      setDigest: controlled.setDigest,
      controlled,
      realModel: {
        apiVersion: 'company-api@1',
        modelVersion: 'vendor-model@2026-09',
        referenceSetDigest: controlled.setDigest,
        cases: [realCase],
        evidence: ['wire probe validated; 1 model call'],
      },
      now: () => '2026-09-30T00:00:00.000Z',
    })
    expect(report.realModel.status).toBe('verified')
    expect(report.realModel.modelVersion).toBe('vendor-model@2026-09')
    expect(report.realModel.evidence).toHaveLength(1)

    expect(() =>
      buildReadinessReport({
        setDigest: controlled.setDigest,
        controlled,
        realModel: {
          apiVersion: 'company-api@1',
          modelVersion: 'vendor-model@2026-09',
          referenceSetDigest: 'sha256:' + '9'.repeat(64),
          cases: [realCase],
          evidence: ['x'],
        },
      }),
    ).toThrow(/reference set digest/)
  })

  it('refuses a dishonest report shape', () => {
    const controlled = buildControlledVerification('sha256:' + '0'.repeat(64), [], 0)
    const base = buildReadinessReport({ setDigest: controlled.setDigest, controlled })
    expect(base.realModel.status).toBe('not_verified')

    expect(() =>
      assertReadinessHonest({
        ...base,
        realModel: { ...base.realModel, evidence: ['a controlled run is not real evidence'] },
      }),
    ).toThrow(/not_verified/)

    expect(() =>
      assertReadinessHonest({
        ...base,
        realModel: { ...base.realModel, status: 'verified', evidence: [] },
      }),
    ).toThrow(/verified/)

    const serialized = JSON.stringify(base)
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('Bearer ')
  })
})
