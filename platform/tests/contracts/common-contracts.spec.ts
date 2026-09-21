import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  createAjv,
  expectInvalid,
  expectValid,
  validator,
  wireRoundTrip,
} from './helpers'

let ajv: Ajv2020
const v = (defName: string): ValidateFunction => validator(ajv, 'common.schema.json', defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('time is RFC3339 UTC only', () => {
  it('accepts UTC instants with optional sub-second precision', () => {
    expectValid(v('Rfc3339UtcTimestamp'), '2026-09-21T00:00:00Z', 'second precision')
    expectValid(v('Rfc3339UtcTimestamp'), '2026-09-21T12:34:56.789Z', 'millisecond precision')
  })

  it('rejects local offsets, date-only and malformed instants', () => {
    expectInvalid(v('Rfc3339UtcTimestamp'), '2026-09-21T12:00:00+08:00', 'non-UTC offset')
    expectInvalid(v('Rfc3339UtcTimestamp'), '2026-09-21T12:00:00-05:00', 'non-UTC offset')
    expectInvalid(v('Rfc3339UtcTimestamp'), '2026-09-21', 'date without time')
    expectInvalid(v('Rfc3339UtcTimestamp'), '2026-09-21T12:00:00', 'missing Z offset')
    expectInvalid(v('Rfc3339UtcTimestamp'), '2026-13-01T00:00:00Z', 'impossible month')
    expectInvalid(v('Rfc3339UtcTimestamp'), 1758412800, 'epoch number is not a timestamp')
  })

  it('keeps the user/billing zone as a separate IANA name', () => {
    expectValid(v('IanaTimeZone'), 'Asia/Shanghai', 'canonical zone')
    expectValid(v('IanaTimeZone'), 'UTC', 'UTC literal')
    expectValid(v('IanaTimeZone'), 'America/Argentina/Buenos_Aires', 'three-level zone')
    expectValid(v('IanaTimeZone'), 'Etc/GMT+8', 'offset-style zone name')
    expectInvalid(v('IanaTimeZone'), '+08:00', 'raw offset is not an IANA name')
    expectInvalid(v('IanaTimeZone'), 'Asia', 'area without location')
    expectInvalid(v('IanaTimeZone'), 'asia/shanghai', 'wrong case')
  })
})

describe('exact decimal amounts', () => {
  it('accepts exact decimal strings with a unit or a currency', () => {
    expectValid(v('DecimalQuantity'), { amount: '0.1', unit: 'kWh' }, 'quantity')
    expectValid(v('DecimalQuantity'), { amount: '-12.50', unit: 'kW' }, 'signed quantity')
    expectValid(v('Money'), { amount: '12345678901234.56', currency: 'CNY' }, 'money')
  })

  it('rejects JSON floats, exponent notation and non-canonical decimals', () => {
    expectInvalid(v('DecimalQuantity'), { amount: 0.1, unit: 'kWh' }, 'JSON float')
    expectInvalid(v('DecimalQuantity'), { amount: '1e3', unit: 'kWh' }, 'exponent notation')
    expectInvalid(v('DecimalQuantity'), { amount: '01', unit: 'kWh' }, 'leading zero')
    expectInvalid(v('DecimalQuantity'), { amount: '1.2.3', unit: 'kWh' }, 'two decimal points')
    expectInvalid(v('DecimalQuantity'), { amount: '.5', unit: 'kWh' }, 'missing integer part')
    expectInvalid(v('DecimalQuantity'), { amount: '1', unit: '' }, 'empty unit')
    expectInvalid(v('DecimalQuantity'), { amount: '1', unit: 'kWh', value: 1 }, 'extra field')
    expectInvalid(v('Money'), { amount: '1', currency: 'cny' }, 'lowercase currency')
    expectInvalid(v('Money'), { amount: '1', currency: 'CN' }, 'two-letter currency')
  })
})

describe('version and resource references', () => {
  it('accepts {id, version, digest} and {id, version, digest, kind}', () => {
    expectValid(
      v('VersionRef'),
      { id: 'home-energy', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
      'version ref',
    )
    expectValid(
      v('ResourceRef'),
      {
        id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
        version: '1.0.0-rc.1',
        digest: `sha256:${'0'.repeat(64)}`,
        kind: 'evidence',
      },
      'resource ref',
    )
  })

  it('rejects missing digests, loose semver and unknown resource kinds', () => {
    expectInvalid(v('VersionRef'), { id: 'x', version: '0.1.0' }, 'missing digest')
    expectInvalid(v('VersionRef'), { id: 'x', version: '1.0', digest: `sha256:${'a'.repeat(64)}` }, 'loose semver')
    expectInvalid(v('VersionRef'), { id: '', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }, 'empty id')
    expectInvalid(
      v('ResourceRef'),
      { id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`, kind: 'blob' },
      'kind outside the enum',
    )
  })

  it('keeps source ids verbatim behind a namespace', () => {
    expectValid(v('SourceRef'), { namespace: 'ha-anker', sourceId: 'sensor.battery_soc_1' }, 'verbatim source id')
    expectInvalid(v('SourceRef'), { namespace: 'HA-ANKER', sourceId: 'x' }, 'uppercase namespace')
    expectInvalid(v('SourceRef'), { namespace: 'ha-anker' }, 'missing source id')
  })
})

describe('integrity digests', () => {
  it('accepts a prefixed sha256 digest and rejects other schemes or lengths', () => {
    expectValid(v('Sha256Digest'), `sha256:${'f'.repeat(64)}`, 'canonical digest')
    expectValid(v('Integrity'), { algorithm: 'sha256', digest: `sha256:${'f'.repeat(64)}` }, 'integrity')
    expectInvalid(v('Sha256Digest'), `md5:${'f'.repeat(32)}`, 'other algorithm')
    expectInvalid(v('Sha256Digest'), `sha256:${'f'.repeat(63)}`, 'short digest')
    expectInvalid(v('Sha256Digest'), `sha256:${'F'.repeat(64)}`, 'uppercase hex')
    expectInvalid(v('Integrity'), { algorithm: 'md5', digest: `sha256:${'f'.repeat(64)}` }, 'wrong algorithm')
    expectInvalid(
      v('Integrity'),
      { algorithm: 'sha256', digest: `sha256:${'f'.repeat(64)}`, salt: 'x' },
      'extra field',
    )
  })
})

describe('identity and validity', () => {
  it('accepts a server-established principal', () => {
    expectValid(
      v('Principal'),
      {
        tenantId: '11111111-2222-4333-8444-555555555555',
        subjectId: 'user:42',
        roles: ['business-user'],
        scopes: ['tenant:11111111-2222-4333-8444-555555555555'],
        authEpoch: 3,
      },
      'principal',
    )
  })

  it('rejects principals that try to smuggle credentials or drop the auth epoch', () => {
    const base = {
      tenantId: '11111111-2222-4333-8444-555555555555',
      subjectId: 'user:42',
      roles: ['business-user'],
      scopes: [],
      authEpoch: 3,
    }
    expectInvalid(v('Principal'), { ...base, authEpoch: -1 }, 'negative auth epoch')
    expectInvalid(v('Principal'), { ...base, authEpoch: undefined }, 'missing auth epoch')
    expectInvalid(v('Principal'), { ...base, accessToken: 'secret' }, 'smuggled token')
    expectInvalid(v('Principal'), { ...base, roles: 'business-user' }, 'roles must be an array')
    expectInvalid(v('Principal'), { ...base, scopes: ['a', 'a'] }, 'duplicate scopes')
  })

  it('treats a validity interval as half-open [validFrom, validTo)', () => {
    expectValid(
      v('ValidityInterval'),
      { validFrom: '2026-01-01T00:00:00Z', validTo: '2026-02-01T00:00:00Z' },
      'bounded interval',
    )
    expectValid(v('ValidityInterval'), { validFrom: '2026-01-01T00:00:00Z' }, 'open-ended interval')
    expectInvalid(v('ValidityInterval'), { validTo: '2026-02-01T00:00:00Z' }, 'missing validFrom')
    expectInvalid(
      v('ValidityInterval'),
      { validFrom: '2026-01-01T00:00:00+00:00' },
      'offset instead of UTC',
    )
  })
})

describe('serialization round-trip', () => {
  it('does not coerce decimals, uuids or digests on the wire', () => {
    const quantity = { amount: '0.30000000000000004', unit: 'kWh' }
    expect(wireRoundTrip(quantity)).toEqual(quantity)
    expect(typeof wireRoundTrip(quantity).amount).toBe('string')

    const ref = {
      id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      version: '1.0.0',
      digest: `sha256:${'9'.repeat(64)}`,
      kind: 'plan',
    }
    expectValid(v('ResourceRef'), wireRoundTrip(ref), 'round-tripped resource ref')
    expect(wireRoundTrip(ref)).toEqual(ref)
  })
})
