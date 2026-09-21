import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { createAjv, expectInvalid, expectValid, validator, wireRoundTrip } from './helpers'

const TENANT = '11111111-2222-4333-8444-555555555555'
const SPACE = '99999999-8888-4777-8666-555555555555'
const EVIDENCE = '7f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const RUN = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const TS = '2026-09-21T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`

const scopeRef = { tenantId: TENANT, spaceId: SPACE }
const componentRef = { id: 'runtime-pi', version: '1.0.0', digest: DIGEST }
const resourceRef = { id: RUN, version: '1.0.0', digest: DIGEST, kind: 'document' }
const sourceSnapshot = {
  sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
  schemaVersion: '2026-09-01',
  readAt: TS,
  consistency: 'read_time',
  resultDigest: DIGEST,
}

let ajv: Ajv2020
const v = (file: string, defName: string): ValidateFunction => validator(ajv, file, defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('evidence envelope', () => {
  const envelope = {
    evidenceId: EVIDENCE,
    kind: 'document_span',
    scopeRef,
    producedBy: { componentRef, runId: RUN },
    observedAt: TS,
    validity: { validFrom: TS },
    sourceSnapshots: [sourceSnapshot],
    resultDigest: DIGEST,
    integrity: { algorithm: 'sha256', digest: DIGEST, verifiedAt: TS },
    dependencies: [
      { evidenceRef: resourceRef, relation: 'derives_from', direction: 'outbound', premiseGroup: 'g1' },
    ],
    dataMode: 'observed',
    payloadRef: resourceRef,
    limitations: ['coverage limited to one document version'],
  }

  it('accepts a fully bound evidence item', () => {
    expectValid(v('evidence.schema.json', 'EvidenceEnvelope'), envelope, 'evidence envelope')
  })

  it('rejects evidence without snapshots, integrity or a data mode', () => {
    const validate = v('evidence.schema.json', 'EvidenceEnvelope')
    expectInvalid(validate, { ...envelope, sourceSnapshots: undefined }, 'missing source snapshots')
    expectInvalid(validate, { ...envelope, integrity: undefined }, 'missing integrity proof')
    expectInvalid(validate, { ...envelope, dataMode: undefined }, 'missing data mode')
    expectInvalid(validate, { ...envelope, dataMode: 'real' }, 'undeclared data mode')
    expectInvalid(validate, { ...envelope, kind: 'vibe' }, 'unknown evidence kind')
    expectInvalid(
      validate,
      { ...envelope, integrity: { algorithm: 'md5', digest: DIGEST } },
      'unsupported integrity algorithm',
    )
  })

  it('distinguishes simulation, observation, forecast and live in the contract (INV-10)', () => {
    const validate = v('evidence.schema.json', 'EvidenceEnvelope')
    for (const dataMode of ['synthetic', 'observed', 'forecast', 'simulation', 'live']) {
      expectValid(validate, { ...envelope, dataMode }, `dataMode ${dataMode}`)
    }
  })

  it('keeps the support/contradiction relation explicit for dependency edges', () => {
    const validate = v('evidence.schema.json', 'EvidenceDependency')
    for (const relation of ['supports', 'contradicts', 'derives_from', 'corrects', 'retracts', 'same_source']) {
      expectValid(
        validate,
        { evidenceRef: resourceRef, relation, direction: 'inbound' },
        `relation ${relation}`,
      )
    }
    expectInvalid(
      validate,
      { evidenceRef: resourceRef, relation: 'implies', direction: 'inbound' },
      'undeclared relation',
    )
  })

  it('round-trips an envelope without losing the exact digest', () => {
    const roundTripped = wireRoundTrip(envelope)
    expect(roundTripped).toEqual(envelope)
    expect(roundTripped.resultDigest).toBe(DIGEST)
    expectValid(v('evidence.schema.json', 'EvidenceEnvelope'), roundTripped, 'round-tripped envelope')
  })
})

describe('evidence manifest', () => {
  it('binds a published answer to one exact manifest hash and policy version', () => {
    const validate = v('evidence.schema.json', 'EvidenceManifest')
    const manifest = {
      manifestHash: DIGEST,
      evidenceRefs: [{ id: EVIDENCE, version: '1.0.0', digest: DIGEST, kind: 'evidence' }],
      createdAt: TS,
      policyVersion: '0.2.0',
    }
    expectValid(validate, manifest, 'evidence manifest')
    expectInvalid(validate, { ...manifest, manifestHash: undefined }, 'missing manifest hash')
    expectInvalid(validate, { ...manifest, policyVersion: undefined }, 'missing policy version')
  })

  it('requires an asOf/validAt query to be an explicit UTC instant', () => {
    const validate = v('evidence.schema.json', 'EvidenceQuery')
    expectValid(validate, { evidenceId: EVIDENCE, asOf: TS, validAt: TS }, 'historical query')
    expectInvalid(validate, { evidenceId: EVIDENCE, asOf: '2026-09-21T00:00:00+08:00' }, 'non-UTC asOf')
  })
})
