import { sha256DigestOf } from '@ontology/core'
import type {
  CapabilityLimits,
  ComputeOperationHandler,
  OperationRegistry,
  RegisteredOperation,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, digestOfSchema } from '../types'
import artifactManifest from './artifacts/example.manifest.json'
import { createHandlers, exampleAlgorithmRef } from './artifacts/example.mjs'
import { EXAMPLE_OPERATION_REF } from './artifacts/example.mjs'
export { EXAMPLE_INPUT_SCHEMA_VERSION, EXAMPLE_OPERATION_REF, EXAMPLE_RESULT_MEDIA_TYPE } from './artifacts/example.mjs'
import { createArtifactComputeHandlers, verifyComputeBuildArtifact } from './build-artifact'
import { ComputeExecutionError } from './errors'
export { decodeInput as decodeExampleComputeInput } from './example-aggregation'

export interface ExampleComputeArtifactOptions {
  /** Host reader for the public @ontology/tool-services/compute/example-artifact static asset. */
  readonly readArtifact: () => Uint8Array
}

/**
 * A neutral, synthetic example compute operation for the generic Core (issue V03-031, SPEC
 * v0.3a §EX-6). It is deliberately not an industry formula: it aggregates an approved immutable
 * input artifact into one quantity (under a neutral, non-industry unit token) and one money
 * total, keeping unit and currency separate, plus a record count. The example is what the
 * acceptance test runs through the normal registry→handler→scoped reader→artifact path; the
 * deployment registers it exactly like a real industry operation, so nothing in the generic
 * Core branches on an industry name.
 */

export const EXAMPLE_ALGORITHM_REF: VersionRef = exampleAlgorithmRef(artifactManifest.handlerDigest)

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

/** The immutable rows artifact read by the handler; distinct from invocation parameters. */
export const EXAMPLE_COMPUTE_DATA_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object', additionalProperties: false, required: ['rows'],
  properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'amount'], properties: { id: { type: 'string' }, amount: { type: 'string' },
      unit: { type: 'string' }, currency: { type: 'string' } } } } },
}
export const EXAMPLE_COMPUTE_INPUT_REQUIREMENTS = {
  maxDecimalPlaces: 4, units: ['each'], currencies: ['CNY'], minimumAmount: '0',
  description: '这项登记计算汇总每件数量与人民币金额，支持非负数、最多四位小数；工时等其他单位暂不可用。',
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
export function exampleRegisteredOperation(options: ExampleComputeArtifactOptions): RegisteredOperation {
  let bytes: Uint8Array
  try { bytes = options.readArtifact() } catch (error) {
    throw new ComputeExecutionError('COMPUTE_CONTRACT_MISMATCH', 'the example compute build artifact is unavailable', { cause: error })
  }
  const artifact = verifyComputeBuildArtifact(artifactManifest, bytes)
  return {
    operationRef: EXAMPLE_OPERATION_REF,
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    inputSchemaDigest: digestOfSchema(INPUT_SCHEMA),
    outputSchemaDigest: digestOfSchema(OUTPUT_SCHEMA),
    handlerRef: { id: 'example.compute.handler', version: '1.0.0', digest: artifact.handlerDigest },
    handlerDigest: artifact.handlerDigest,
    readOnly: true,
    requiredCapabilities: [],
    limits: EXAMPLE_OPERATION_LIMITS,
    dataMode: 'synthetic',
  }
}

export function exampleOperationRegistry(options: ExampleComputeArtifactOptions): OperationRegistry {
  const operations = [exampleRegisteredOperation(options)]
  return {
    namespace: 'example',
    registryVersion: '1.0.0',
    registryDigest: sha256DigestOf(canonicalJson(operations)),
    operations,
  }
}

export function createExampleComputeHandlers(options: ExampleComputeArtifactOptions): readonly ComputeOperationHandler[] {
  return createArtifactComputeHandlers({ manifest: artifactManifest, readArtifact: options.readArtifact, factory: createHandlers })
}
