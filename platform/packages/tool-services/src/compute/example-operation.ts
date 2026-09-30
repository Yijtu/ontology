import { sha256DigestOf } from '@ontology/core'
import type {
  CapabilityLimits,
  ComputeOperationHandler,
  ComputeOperationRequest,
  ComputeOperationResult,
  ComputeSourceObservation,
  ComputationData,
  DataQueryOutput,
  DomainResultStatus,
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  SourceRef,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, digestOfSchema } from '../types'
import { ComputeExecutionError } from './errors'

/**
 * A neutral, synthetic example compute operation for the generic Core (issue V03-031, SPEC
 * v0.3a §EX-6). It is deliberately not an industry formula: it aggregates an approved immutable
 * input artifact into one quantity (under a neutral, non-industry unit token) and one money
 * total, keeping unit and currency separate, plus a record count. The example is what the
 * acceptance test runs through the normal registry→handler→scoped reader→artifact path; the
 * deployment registers it exactly like a real industry operation, so nothing in the generic
 * Core branches on an industry name.
 */

const EXAMPLE_SOURCE_REF: SourceRef = { namespace: 'example', sourceId: 'compute' }

/** A neutral, non-industry unit token for the aggregated quantity; the example asserts no physical dimension. */
const QUANTITY_UNIT = 'each'

export const EXAMPLE_INPUT_SCHEMA_VERSION = 'example-compute-input@1'

export const EXAMPLE_OPERATION_REF: OperationRef = { id: 'example.compute.aggregate', version: '1.0.0' }

export const EXAMPLE_ALGORITHM_REF: VersionRef = {
  id: 'example.aggregate',
  version: '1.0.0',
  digest: sha256DigestOf('example.aggregate@1.0.0'),
}

export const EXAMPLE_RESULT_MEDIA_TYPE = 'application/vnd.ontology.example-compute-result+json'

/**
 * The parameter schema of the example operation. Parameters are advisory scalars; the records
 * being aggregated are the fixed input artifact read through the scoped reader, so the schema is
 * closed and empty. (A missing/extra parameter is still a contract violation.)
 */
const INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['metrics'],
  properties: { metrics: { type: 'object' } },
}

export const EXAMPLE_OPERATION_LIMITS: CapabilityLimits = {
  maxRows: 1_000,
  maxBytes: 1_048_576,
  maxDurationMs: 10_000,
  maxConcurrency: 1,
}

/** The registered operation record; the deployment owns the registry digest in its manifest. */
export function exampleRegisteredOperation(): RegisteredOperation {
  return {
    operationRef: EXAMPLE_OPERATION_REF,
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    inputSchemaDigest: digestOfSchema(INPUT_SCHEMA),
    outputSchemaDigest: digestOfSchema(OUTPUT_SCHEMA),
    handlerRef: { id: 'example.compute.handler', version: '1.0.0', digest: sha256DigestOf('example.compute.handler@1.0.0') },
    handlerDigest: sha256DigestOf('example.compute.handler@1.0.0'),
    readOnly: true,
    requiredCapabilities: [],
    limits: EXAMPLE_OPERATION_LIMITS,
    dataMode: 'synthetic',
  }
}

export function exampleOperationRegistry(): OperationRegistry {
  const operations = [exampleRegisteredOperation()]
  return {
    namespace: 'example',
    registryVersion: '1.0.0',
    registryDigest: sha256DigestOf(canonicalJson(operations)),
    operations,
  }
}

interface ExampleRow {
  readonly id: string
  readonly amount: string
  readonly unit?: string
  readonly currency?: string
}

const SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(SCALE)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an exact DecimalString into a fixed 4-dp integer; exponent/float forms are rejected. */
function parseDecimal(value: string): bigint | undefined {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value)
  if (match === null) return undefined
  const whole = match[1] ?? '0'
  const frac = (match[2] ?? '').padEnd(SCALE, '0').slice(0, SCALE)
  return BigInt(whole) * SCALE_FACTOR + BigInt(frac)
}

function formatDecimal(scaled: bigint): string {
  const whole = scaled / SCALE_FACTOR
  const fraction = (scaled % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/u, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

function decodeInput(bytes: Uint8Array): { readonly rows: readonly ExampleRow[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'the example input artifact is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['rows'])) {
    throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'the example input artifact must carry a rows array')
  }
  const rows: ExampleRow[] = []
  for (const entry of parsed['rows']) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['amount'] !== 'string') {
      throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'every example input row needs a string id and amount')
    }
    rows.push({
      id: entry['id'],
      amount: entry['amount'],
      ...(typeof entry['unit'] === 'string' ? { unit: entry['unit'] } : {}),
      ...(typeof entry['currency'] === 'string' ? { currency: entry['currency'] } : {}),
    })
  }
  return { rows }
}

interface Aggregation {
  readonly metrics: Readonly<Record<string, unknown>>
  readonly domainStatus: DomainResultStatus
  readonly completeness: 'complete' | 'unknown'
  readonly returned: number
}

/**
 * Aggregate the fixed input. If any row's amount is not an exact DecimalString, the totals are
 * omitted and the result is `unknown`/incomplete — the handler never substitutes a default or a
 * fabricated total for a value it could not compute.
 */
function aggregate(rows: readonly ExampleRow[]): Aggregation {
  let quantity = 0n
  let cost = 0n
  for (const row of rows) {
    const parsed = parseDecimal(row.amount)
    if (parsed === undefined) {
      return {
        metrics: { record_count: rows.length },
        domainStatus: 'unknown',
        completeness: 'unknown',
        returned: 0,
      }
    }
    if (row.unit === QUANTITY_UNIT) quantity += parsed
    if (row.currency === 'CNY') cost += parsed
  }
  return {
    metrics: {
      record_count: rows.length,
      total_quantity: { amount: formatDecimal(quantity), unit: QUANTITY_UNIT },
      total_cost: { amount: formatDecimal(cost), currency: 'CNY' },
    },
    domainStatus: 'known',
    completeness: 'complete',
    returned: rows.length,
  }
}

export function createExampleComputeHandlers(): readonly ComputeOperationHandler[] {
  const handler: ComputeOperationHandler = {
    operationRef: EXAMPLE_OPERATION_REF,
    async execute(request: ComputeOperationRequest): Promise<ComputeOperationResult> {
      const ref = request.inputRefs[0]
      if (ref === undefined) {
        throw new ComputeExecutionError(
          'COMPUTE_INPUT_MISSING',
          'the example operation requires at least one approved input reference',
        )
      }
      const bytes = await request.readInput.read({ approvedInputRefs: [ref] }, request.ctx)
      const { rows } = decodeInput(bytes)
      const aggregation = aggregate(rows)
      const stored = await request.artifacts.putBytes(
        {
          scopeRef: { tenantId: request.ctx.principal.tenantId, spaceId: request.ctx.allowedResources.spaceId },
          content: new TextEncoder().encode(
            canonicalJson({ operationRef: request.operationRef, metrics: aggregation.metrics }),
          ),
          mediaType: EXAMPLE_RESULT_MEDIA_TYPE,
        },
        request.ctx,
      )
      const source: ComputeSourceObservation = {
        sourceRef: EXAMPLE_SOURCE_REF,
        schemaVersion: EXAMPLE_INPUT_SCHEMA_VERSION,
        consistency: 'immutable',
        resultDigest: stored.blobRef.digest,
      }
      const computation: ComputationData = {
        operationRef: request.operationRef,
        resultRef: stored.blobRef,
        algorithmVersion: EXAMPLE_ALGORITHM_REF,
        metrics: aggregation.metrics,
        domainStatus: aggregation.domainStatus,
      }
      const payload: DataQueryOutput = { resultKind: 'computation', computation }
      return {
        payload,
        status: 'ok',
        coverage: {
          returned: aggregation.returned,
          truncated: false,
          completeness: aggregation.completeness,
        },
        sources: [source],
        domainStatus: aggregation.domainStatus,
        dataMode: 'synthetic',
        evidenceKind: 'computation',
      }
    },
  }
  return [handler]
}
