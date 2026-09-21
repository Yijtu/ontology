import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  CONTROLLER_SERVICE_IDS,
  TOOL_CATALOGUE,
  TOOL_IDS,
  findRegisteredOperation,
  isToolContext,
  createToolContext,
  type OperationRegistry,
  type ToolContext,
  type ToolContextData,
} from '@ontology/contracts'
import {
  createAjv,
  expectInvalid,
  expectValid,
  readFixture,
  readSchemaDocument,
  schemaFiles,
  validator,
  validatorForRef,
  collectPropertyNames,
  collectRefs,
} from './helpers'

const TENANT = '11111111-2222-4333-8444-555555555555'
const SPACE = '99999999-8888-4777-8666-555555555555'
const CALL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DIGEST = `sha256:${'a'.repeat(64)}`

const scopeRef = { tenantId: TENANT, spaceId: SPACE }
const versionRef = { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST }
const resourceRef = {
  id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  version: '1.0.0',
  digest: DIGEST,
  kind: 'dataset',
}
const sourceSnapshot = {
  sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
  schemaVersion: '2026-09-01',
  readAt: '2026-09-21T00:00:00Z',
  consistency: 'read_time',
  resultDigest: DIGEST,
}

const computeInput = {
  kind: 'compute',
  operationRef: { id: 'home-energy.plan', version: '1' },
  inputSchemaDigest: `sha256:${'2'.repeat(64)}`,
  inputRefs: [resourceRef],
  parameters: { siteRef: 'site-demo-a', strategyWhitelist: ['self_consumption'] },
}

const validToolArguments: Record<string, unknown> = {
  ontology_lookup: { scopeRef, intent: 'definitions' },
  data_query: computeInput,
  document_search: {
    query: '备电要求',
    allowedCollectionRefs: ['home-energy/manuals'],
    mode: 'keyword',
  },
  web_search: { query: 'home energy tariff', allowedDomains: ['example.com'] },
}

const invalidToolArguments: Record<string, unknown> = {
  ontology_lookup: { scopeRef, intent: 'everything' },
  data_query: { kind: 'compute', operationRef: { id: 'home-energy.plan', version: '1' } },
  document_search: { query: 'x', allowedCollectionRefs: [], mode: 'fuzzy' },
  web_search: { query: 'x', allowedDomains: ['http://example.com'] },
}

let ajv: Ajv2020
const v = (file: string, defName: string): ValidateFunction => validator(ajv, file, defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('the fixed four-tool catalogue', () => {
  it('contains exactly the four model-visible tools and nothing else', () => {
    expect(TOOL_CATALOGUE).toHaveLength(4)
    expect(TOOL_IDS).toEqual(['ontology_lookup', 'data_query', 'document_search', 'web_search'])
    expect(TOOL_CATALOGUE.map((tool) => tool.toolId)).toEqual([...TOOL_IDS])
  })

  it('keeps verify_result and final_answer out of the model catalogue (ADR-04)', () => {
    expect(CONTROLLER_SERVICE_IDS).toEqual(['verify_result', 'final_answer'])
    for (const controllerService of CONTROLLER_SERVICE_IDS) {
      expect(TOOL_IDS).not.toContain(controllerService)
    }
  })

  it('declares every tool as read-only and conforms to the ToolDefinition schema', () => {
    const validateDefinition = v('tools.schema.json', 'ToolDefinition')
    for (const tool of TOOL_CATALOGUE) {
      expectValid(validateDefinition, tool, `${tool.toolId} definition`)
      expect(tool.readOnly).toBe(true)
      expect(tool.requiredCapabilities.length).toBeGreaterThan(0)
      expect(tool.resultLimits.maxRows).toBeGreaterThan(0)
    }
  })

  it('exposes a resolvable, standalone input schema for every tool', () => {
    for (const tool of TOOL_CATALOGUE) {
      const validateInput = validatorForRef(ajv, String(tool.inputSchema.$ref))
      expectValid(validateInput, validToolArguments[tool.toolId], `${tool.toolId} valid arguments`)
      expectInvalid(validateInput, invalidToolArguments[tool.toolId], `${tool.toolId} invalid arguments`)
      expectInvalid(
        validateInput,
        { ...(validToolArguments[tool.toolId] as object), toolContext: {} },
        `${tool.toolId} rejects a smuggled toolContext`,
      )
    }
  })

  it('rejects a tool catalogue that lists an unregistered tool id', () => {
    const validateDefinition = v('tools.schema.json', 'ToolDefinition')
    expectInvalid(
      validateDefinition,
      { ...TOOL_CATALOGUE[1], toolId: 'execute_sql' },
      'tool id outside the closed catalogue',
    )
  })
})

describe('data_query is a discriminated union', () => {
  const validate = (): ValidateFunction => v('tools.schema.json', 'DataQueryInput')

  it('accepts describe, direct query, semantic query and compute', () => {
    expectValid(validate(), { kind: 'describe' }, 'describe')
    expectValid(
      validate(),
      {
        kind: 'query',
        mode: 'direct',
        queryPlan: {
          mode: 'direct',
          statementKind: 'select',
          sql: 'SELECT load_kw FROM public.load WHERE ts >= $1',
          parameters: ['2026-09-21T00:00:00Z'],
          referencedObjects: [
            { sourceRef: { namespace: 'ha-anker', sourceId: 'warehouse' }, objectPath: 'public.load' },
          ],
          readOnly: true,
        },
      },
      'direct query',
    )
    expectValid(
      validate(),
      {
        kind: 'query',
        mode: 'semantic',
        queryPlan: {
          mode: 'semantic',
          concepts: ['home-energy.load'],
          fields: ['home-energy.load.power'],
          links: [],
          filters: [{ fieldRef: 'home-energy.load.power', op: 'gte', values: [1] }],
          orderBy: [{ fieldRef: 'home-energy.load.ts', direction: 'asc' }],
          limit: 100,
          mappingVersion: versionRef,
        },
      },
      'semantic query',
    )
    expectValid(validate(), computeInput, 'compute')
  })

  it('rejects a mode/plan mismatch, unknown kinds and extra fields', () => {
    expectInvalid(validate(), { kind: 'select' }, 'unknown kind')
    expectInvalid(
      validate(),
      {
        kind: 'query',
        mode: 'direct',
        queryPlan: {
          mode: 'semantic',
          concepts: ['x'],
          fields: ['y'],
          links: [],
          filters: [],
          orderBy: [],
          limit: 1,
          mappingVersion: versionRef,
        },
      },
      'direct mode with a semantic plan',
    )
    expectInvalid(
      validate(),
      { ...computeInput, code: 'export function hack() {}' },
      'arbitrary code is not a field (ADR-11)',
    )
    expectInvalid(
      validate(),
      { ...computeInput, packagePath: '../../extensions/home-energy/src/index.ts' },
      'a user question cannot pick a handler path',
    )
  })

  it('rejects a direct plan that is not a single read-only select', () => {
    const validatePlan = v('data.schema.json', 'DirectSqlQueryPlan')
    const base = {
      mode: 'direct',
      statementKind: 'select',
      sql: 'SELECT 1',
      parameters: [],
      referencedObjects: [
        { sourceRef: { namespace: 'ha-anker', sourceId: 'warehouse' }, objectPath: 'public.load' },
      ],
      readOnly: true,
    }
    expectValid(validatePlan, base, 'read-only select')
    expectInvalid(validatePlan, { ...base, statementKind: 'insert' }, 'DML statement kind')
    expectInvalid(validatePlan, { ...base, readOnly: false }, 'writable plan')
    expectInvalid(validatePlan, { ...base, referencedObjects: [] }, 'unbounded object list')
  })
})

describe('compute may only reference a registered operation (ADR-11)', () => {
  const registry = readFixture('operation-registry.json') as OperationRegistry

  it('validates the registry fixture against the canonical registry schema', () => {
    expectValid(v('operations.schema.json', 'OperationRegistry'), registry, 'operation registry')
  })

  it('resolves a registered operation and its input schema digest', () => {
    const plan = findRegisteredOperation(
      registry,
      { id: 'home-energy.plan', version: '1' },
      `sha256:${'2'.repeat(64)}`,
    )
    expect(plan).toBeDefined()
    expect(plan?.operationRef).toEqual({ id: 'home-energy.plan', version: '1' })
    expect(plan?.readOnly).toBe(true)
    expect(plan?.dataMode).toBe('simulation')
  })

  it('rejects unregistered operations, wrong versions and stale schema digests', () => {
    expect(findRegisteredOperation(registry, { id: 'home-energy.plan', version: '2' })).toBeUndefined()
    expect(findRegisteredOperation(registry, { id: 'home-energy.dispatch', version: '1' })).toBeUndefined()
    expect(
      findRegisteredOperation(
        registry,
        { id: 'home-energy.plan', version: '1' },
        `sha256:${'f'.repeat(64)}`,
      ),
    ).toBeUndefined()
  })

  it('validates compute parameters against the registered operation input schema', () => {
    const plan = findRegisteredOperation(registry, { id: 'home-energy.plan', version: '1' })
    expect(plan).toBeDefined()
    if (plan === undefined) return

    const validateParameters = ajv.compile(plan.inputSchema)
    expectValid(validateParameters, computeInput.parameters, 'registered parameters')
    expectInvalid(
      validateParameters,
      { siteRef: 'site-demo-a', strategyWhitelist: ['sell_everything'] },
      'strategy outside the whitelist',
    )
    expectInvalid(validateParameters, { strategyWhitelist: ['self_consumption'] }, 'missing siteRef')
  })
})

describe('public web content has no instruction authority (INV-07)', () => {
  const page = {
    url: 'https://example.com/tariff',
    title: 'Residential tariff',
    fetchedAt: '2026-09-21T00:00:00Z',
    snippet: 'Peak price is 1.2 CNY/kWh.',
    contentTrust: 'untrusted_data',
    contentDigest: DIGEST,
  }

  it('labels every fetched page as untrusted data', () => {
    const validate = v('tools.schema.json', 'WebPageEvidence')
    expectValid(validate, page, 'web page evidence')
    expectInvalid(validate, { ...page, contentTrust: 'trusted_instruction' }, 'page claiming instruction authority')
    expectInvalid(validate, { ...page, contentTrust: undefined }, 'page without a trust label')
    expectInvalid(validate, { ...page, url: 'http://example.com/tariff' }, 'plaintext url')
  })
})

describe('unified ToolResult', () => {
  const validate = (): ValidateFunction => v('tools.schema.json', 'ToolResult')

  const base = {
    callId: CALL_ID,
    status: 'ok',
    dataRef: resourceRef,
    schemaRef: versionRef,
    evidenceRefs: [resourceRef],
    sourceSnapshots: [sourceSnapshot],
    coverage: { returned: 1, truncated: false },
    usage: { durationMs: 12, rows: 1 },
    warnings: [],
  }

  it('accepts a traceable success and a successful empty result', () => {
    expectValid(validate(), base, 'ok result')
    expectValid(
      validate(),
      { ...base, status: 'empty', inlineData: [], coverage: { returned: 0, truncated: false } },
      'empty is a success, not an error',
    )
  })

  it('rejects results without evidence, coverage or a known status', () => {
    expectInvalid(validate(), { ...base, status: 'success' }, 'status outside ok|partial|empty|error')
    expectInvalid(validate(), { ...base, evidenceRefs: undefined }, 'missing evidence refs')
    expectInvalid(validate(), { ...base, coverage: undefined }, 'missing coverage')
    expectInvalid(validate(), { ...base, error: { code: 'TEAPOT', message: 'x', retryable: false } }, 'unknown error code')
  })

  it('records truncation and completeness instead of implying the full set exists', () => {
    const validateCoverage = v('tools.schema.json', 'ToolCoverage')
    expectValid(
      validateCoverage,
      { returned: 10, knownTotal: 500, cursor: 'opaque-cursor-1', truncated: true, completeness: 'truncated' },
      'truncated page',
    )
    expectInvalid(validateCoverage, { returned: 10 }, 'missing truncated flag')
  })
})

describe('ToolContext cannot be built from model arguments', () => {
  const fields: ToolContextData = {
    principal: {
      tenantId: TENANT,
      subjectId: 'user:42',
      roles: ['business-user'],
      scopes: [],
      authEpoch: 1,
    },
    runId: CALL_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: CALL_ID,
      runId: CALL_ID,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['evidence', 'dataset'],
      sourceRefs: [{ namespace: 'ha-anker', sourceId: 'sensor.battery_soc' }],
      collectionRefs: ['home-energy/manuals'],
      domains: ['example.com'],
      maxRows: 1000,
    },
    traceId: 'trace-0001',
  }

  it('is branded so a model-shaped object does not satisfy it (type level)', () => {
    // @ts-expect-error a plain ToolContextData object lacks the runtime brand
    const forged: ToolContext = fields
    void forged

    const trusted: ToolContext = createToolContext(fields)
    const asData: ToolContextData = trusted
    void asData

    expectTypeOf<ToolContext>().not.toEqualTypeOf<ToolContextData>()
  })

  it('is branded at runtime: deserialized or model-shaped input is rejected', () => {
    expect(isToolContext(fields)).toBe(false)
    expect(isToolContext(JSON.parse(JSON.stringify(fields)))).toBe(false)
    expect(isToolContext(null)).toBe(false)

    const trusted = createToolContext(fields)
    expect(isToolContext(trusted)).toBe(true)
    expect(Object.isFrozen(trusted)).toBe(true)
    expect(trusted.principal.subjectId).toBe('user:42')
  })

  it('is unreachable from every canonical wire schema', () => {
    const allRefs: string[] = []
    const allProperties = new Set<string>()
    for (const file of schemaFiles()) {
      const doc = readSchemaDocument(file)
      allRefs.push(...collectRefs(doc))
      for (const name of collectPropertyNames(doc)) allProperties.add(name)
    }

    expect(allRefs.filter((ref) => ref.includes('ToolContextData'))).toEqual([])
    expect(allProperties.has('toolContext')).toBe(false)
  })

  it('is required to carry exactly the C4 fields', () => {
    const def = readSchemaDocument('tools.schema.json').$defs?.ToolContextData as {
      required: string[]
      additionalProperties: boolean
    }
    expect([...def.required].sort()).toEqual(
      [
        'allowedResources',
        'budgetReservation',
        'deadline',
        'policyVersion',
        'principal',
        'resolvedProfileHash',
        'runId',
        'traceId',
      ].sort(),
    )
    expect(def.additionalProperties).toBe(false)
  })
})
