import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  canRetireComponentVersion,
  canTransitionLifecycle,
  compareSemver,
  findEmbeddedSecretViolations,
  findIndustryPackViolations,
  hasWellFormedCapabilityRequirements,
  isValidContractRange,
  nextLifecycleStates,
  satisfiesContractRange,
  type ComponentVersionRecord,
  type ContractRange,
  type IndustryManifest,
} from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, platformRoot, readFixture, validator } from './helpers'

let ajv: Ajv2020
const v = (defName: string): ValidateFunction => validator(ajv, 'industry.schema.json', defName)

const DIGEST = `sha256:${'a'.repeat(64)}`
const validPack = (): IndustryManifest =>
  readFixture('industry-pack.home-energy.json') as IndustryManifest
const clonePack = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(validPack())) as Record<string, unknown>

beforeAll(() => {
  ajv = createAjv()
})

describe('IndustryManifest declaration (US-001, FR-1, FR-31)', () => {
  it('accepts a declaration that carries only semantics, refs and maturity', () => {
    expectValid(v('IndustryManifest'), validPack(), 'home-energy pack')
  })

  it('requires maturity and at least one standard provenance entry', () => {
    const noMaturity = clonePack()
    delete noMaturity.maturity
    expectInvalid(v('IndustryManifest'), noMaturity, 'missing maturity')

    const noProvenance = clonePack()
    delete noProvenance.standardProvenance
    expectInvalid(v('IndustryManifest'), noProvenance, 'missing standard provenance')

    expectInvalid(
      v('IndustryManifest'),
      { ...clonePack(), standardProvenance: [] },
      'empty standard provenance',
    )
    expectInvalid(v('IndustryManifest'), { ...clonePack(), maturity: 'ga' }, 'unknown maturity')
  })

  it('rejects a manifest that drops a required declaration field', () => {
    for (const field of [
      'namespace',
      'definitionsRef',
      'identityPolicyRef',
      'rulePolicyRef',
      'queryTemplatesRef',
      'requiredCapabilities',
      'testSuiteRef',
    ]) {
      const pack = clonePack()
      delete pack[field]
      expectInvalid(v('IndustryManifest'), pack, `missing ${field}`)
    }
  })

  it('rejects an inlined runtime binding, SDK dependency or credential', () => {
    expectInvalid(
      v('IndustryManifest'),
      { ...clonePack(), runtimeRef: { id: 'runtime-pi', version: '1.0.0', digest: DIGEST } },
      'inline runtime binding',
    )
    expectInvalid(v('IndustryManifest'), { ...clonePack(), dependencies: { pi: '1.0.0' } }, 'inline SDK dependency')
    expectInvalid(v('IndustryManifest'), { ...clonePack(), credentials: { password: 'x' } }, 'inline credential')
  })

  it('requires every required capability to declare a name and a range', () => {
    expectInvalid(
      v('IndustryManifest'),
      { ...clonePack(), requiredCapabilities: [] },
      'no required capability',
    )
    expectInvalid(
      v('IndustryManifest'),
      {
        ...clonePack(),
        requiredCapabilities: [{ name: 'structured_query' }],
      },
      'capability without a range',
    )
  })
})

describe('industry pack purity scan (INV-03, ADR-10, US-023)', () => {
  it('finds no violation in a declaration that only holds semantics and refs', () => {
    expect(findIndustryPackViolations(validPack())).toEqual([])
  })

  it('rejects credentials, URLs, SDK dependencies and executable scripts', () => {
    const credential = findIndustryPackViolations({ ...clonePack(), clientSecret: 'abc123' })
    expect(credential.map((entry) => entry.code)).toContain('forbidden_field')
    expect(credential.map((entry) => entry.path)).toContain('$.clientSecret')

    const url = findIndustryPackViolations({
      ...clonePack(),
      definitionsRef: { id: 'postgres://user@host/db', version: '1.0.0', digest: DIGEST },
    })
    expect(url.map((entry) => entry.code)).toContain('uri_value')

    const sdk = findIndustryPackViolations({ ...clonePack(), sdk: '@earendil-works/pi' })
    expect(sdk.map((entry) => entry.code)).toContain('forbidden_field')

    const script = findIndustryPackViolations({ ...clonePack(), queryTemplatesRef: '#!/bin/sh\necho hi' })
    expect(script.map((entry) => entry.code)).toContain('script_value')

    const sql = findIndustryPackViolations({ ...clonePack(), definitionsRef: 'SELECT * FROM meter_reading' })
    expect(sql.map((entry) => entry.code)).toContain('script_value')
  })

  it('rejects physical table/column addressing inside a pack', () => {
    for (const key of ['objectPath', 'sourceObjectRef', 'tableName', 'columnName', 'schemaname']) {
      const violations = findIndustryPackViolations({ ...clonePack(), [key]: 'public.meter_reading' })
      expect(violations.map((entry) => entry.code), key).toContain('forbidden_field')
    }
  })

  it('rejects customer instance data inside a shared pack', () => {
    for (const key of ['tenantId', 'spaceId', 'customerId', 'instanceId', 'siteRef', 'deviceId']) {
      const violations = findIndustryPackViolations({ ...clonePack(), [key]: 'customer-a' })
      expect(violations.map((entry) => entry.code), key).toContain('forbidden_field')
    }
  })

  it('reports the exact JSON path of a nested leak', () => {
    const violations = findIndustryPackViolations({
      ...clonePack(),
      requiredCapabilities: [{ name: 'x', versionRange: { min: '1.0.0' }, password: 'p' }],
    })
    expect(violations.some((entry) => entry.path === '$.requiredCapabilities[0].password')).toBe(true)
  })
})

describe('deployment profiles stay refs-only (SPEC 2.2)', () => {
  const profileDir = join(platformRoot, 'deployment-profiles')

  it('ships at least one deployment profile and none embeds a secret or URL', () => {
    const files = readdirSync(profileDir).filter((name) => name.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const document = JSON.parse(readFileSync(join(profileDir, file), 'utf8')) as unknown
      expect(findEmbeddedSecretViolations(document), file).toEqual([])
    }
  })

  it('flags a secret value when one is smuggled into a refs-only config', () => {
    expect(findEmbeddedSecretViolations({ secretRef: 'sk-live-0123456789abcdef' }).length).toBeGreaterThan(0)
    expect(findEmbeddedSecretViolations({ dsn: 'postgres://user:pass@host/db' }).length).toBeGreaterThan(0)
    expect(
      findEmbeddedSecretViolations({ key: '-----BEGIN RSA PRIVATE KEY-----' }).length,
    ).toBeGreaterThan(0)
  })
})

describe('contract range ordering (C1 preflight)', () => {
  it('accepts half-open ranges and rejects empty or inverted ones', () => {
    expect(isValidContractRange({ min: '1.0.0', max: '2.0.0' })).toBe(true)
    expect(isValidContractRange({ min: '1.0.0' })).toBe(true)
    expect(isValidContractRange({ min: '1.0.0', max: '1.0.0' })).toBe(false)
    expect(isValidContractRange({ min: '2.0.0', max: '1.0.0' })).toBe(false)
    expect(isValidContractRange({ min: 'not-semver' })).toBe(false)
  })

  it('resolves exact versions against the half-open range', () => {
    const range: ContractRange = { min: '1.0.0', max: '2.0.0' }
    expect(satisfiesContractRange(range, '1.0.0')).toBe(true)
    expect(satisfiesContractRange(range, '1.9.9')).toBe(true)
    expect(satisfiesContractRange(range, '2.0.0')).toBe(false)
    expect(satisfiesContractRange(range, '0.9.9')).toBe(false)
    expect(satisfiesContractRange({ min: '1.0.0' }, '99.0.0')).toBe(true)
  })

  it('orders prerelease versions below their release', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(() => compareSemver('1.2', '1.2.3')).toThrow()
  })

  it('reports a pack whose capability ranges are not well formed', () => {
    expect(hasWellFormedCapabilityRequirements(validPack().requiredCapabilities)).toBe(true)
    expect(
      hasWellFormedCapabilityRequirements([
        { name: 'structured_query', versionRange: { min: '2.0.0', max: '1.0.0' } },
      ]),
    ).toBe(false)
    expect(hasWellFormedCapabilityRequirements([])).toBe(false)
  })
})

describe('module lifecycle (C1)', () => {
  const record = (lifecycleState: ComponentVersionRecord['lifecycleState']): ComponentVersionRecord => ({
    manifestRef: { id: 'runtime-pi', version: '1.0.0', digest: DIGEST },
    manifest: {
      kind: 'runtime',
      id: 'runtime-pi',
      version: '1.0.0',
      digest: DIGEST,
      contractRange: { min: '1.0.0', max: '2.0.0' },
      provides: [
        {
          name: 'agent_runtime',
          version: '1.0.0',
          limits: { maxRows: 1, maxBytes: 1, maxDurationMs: 1 },
          consistency: 'unknown',
          cancellation: 'best_effort',
          pagination: 'none',
          supportedDataTypes: ['json'],
        },
      ],
      requires: [],
      entrypointRef: { kind: 'module', ref: 'runtime-pi' },
      trustStatus: 'local_dev',
    },
    lifecycleState,
    registeredAt: '2026-09-21T00:00:00Z',
  })

  it('only allows the declared lifecycle order', () => {
    expect(nextLifecycleStates('registered')).toEqual(['validated'])
    expect(canTransitionLifecycle('registered', 'validated')).toBe(true)
    expect(canTransitionLifecycle('validated', 'active')).toBe(true)
    expect(canTransitionLifecycle('active', 'deprecated')).toBe(true)
    expect(canTransitionLifecycle('deprecated', 'retired')).toBe(true)
    expect(canTransitionLifecycle('registered', 'active')).toBe(false)
    expect(canTransitionLifecycle('active', 'retired')).toBe(false)
    expect(canTransitionLifecycle('retired', 'validated')).toBe(false)
  })

  it('never retires a version an active run still references', () => {
    expect(canRetireComponentVersion(record('deprecated'), [])).toBe(true)
    expect(canRetireComponentVersion(record('active'), [])).toBe(false)
    expect(canRetireComponentVersion(record('deprecated'), [record('deprecated').manifestRef])).toBe(false)
    expect(
      canRetireComponentVersion(record('deprecated'), [
        { id: 'runtime-pi', version: '2.0.0', digest: DIGEST },
      ]),
    ).toBe(true)
  })
})
