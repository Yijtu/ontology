import { sha256DigestOf } from '@ontology/core'
import type {
  ComputeBinding,
  ComputeOperationHandler,
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  Sha256Digest,
} from '@ontology/contracts'
import {
  EXAMPLE_COMPUTE_DATA_SCHEMA,
  canonicalJson,
  createExampleComputeHandlers,
  exampleRegisteredOperation,
  registeredOperationDigest,
} from '@ontology/tool-services'

/**
 * The deployment-supplied registered-compute surface (ADR-11, SPEC v0.3a §EX-6). The generic
 * Core no longer hardcodes the neutral example operation inside the composition root: a host
 * passes its whole registration, and the sample deployment passes exactly the example one. This
 * is the seam a real customer operation (e.g. an electrical-costing quote function) plugs into
 * without editing the kernel.
 */
export interface RegisteredComputeOperation {
  readonly operation: RegisteredOperation
  /** The component entrypoint ref recorded in the registry (e.g. the packaged build artifact). */
  readonly entrypoint: string
  /** Host-owned reader for the verified build artifact; a generic host component stages a manifest. */
  readonly readArtifact: () => Uint8Array
  readonly artifactMediaType: string
}

export interface CoreComputeRegistration {
  /** The operation registry the run preflight and gateway pin against. */
  readonly registry: OperationRegistry
  /** The deterministic handlers that execute the registered operations. */
  readonly handlers: readonly ComputeOperationHandler[]
  /** The registrations whose component records and build artifacts the host mounts. */
  readonly operations: readonly RegisteredComputeOperation[]
  /**
   * The registered operation (and the immutable data schema of its approved-input rows) this
   * host has a fixed approved-field input builder for. A host without such a builder rejects the
   * operation rather than inventing an input.
   */
  readonly approvedInput: {
    readonly operationRef: OperationRef
    readonly dataSchema: Readonly<Record<string, unknown>>
  }
  /** The profile compute bindings the host publishes for its registered operations. */
  readonly profileBindings: readonly ComputeBinding[]
  /** The operation the mounted compute task binding pins. */
  readonly primary: {
    readonly operationRef: OperationRef
    readonly registeredOperationDigest: Sha256Digest
  }
}

/** Build the profile compute binding for one registered operation (mirrors the ADR-11 binding). */
export function computeBindingFor(operation: RegisteredOperation, version: string): ComputeBinding {
  return {
    operationRef: operation.operationRef,
    handlerRef: operation.handlerRef,
    inputSchemaRef: {
      id: `${operation.operationRef.id}.input`,
      version,
      digest: operation.inputSchemaDigest,
    },
    outputSchemaRef: {
      id: `${operation.operationRef.id}.output`,
      version,
      digest: operation.outputSchemaDigest,
    },
    readOnly: true,
    enabled: true,
    limits: operation.limits,
  }
}

/**
 * The default registration: the single neutral, synthetic example operation. It is registered
 * exactly like an industry operation so nothing in the generic Core branches on a name; this
 * factory is the only place the sample deployment binds that example.
 */
export function defaultCoreComputeRegistration(input: {
  readonly artifact: { readonly readArtifact: () => Uint8Array }
  readonly version: string
}): CoreComputeRegistration {
  const operation = exampleRegisteredOperation(input.artifact)
  const registry: OperationRegistry = {
    namespace: 'core-local',
    registryVersion: input.version,
    registryDigest: sha256DigestOf(canonicalJson([operation])),
    operations: [operation],
  }
  return {
    registry,
    handlers: createExampleComputeHandlers(input.artifact),
    operations: [{
      operation,
      entrypoint: '@ontology/tool-services/compute/example-artifact',
      readArtifact: input.artifact.readArtifact,
      artifactMediaType: 'text/javascript',
    }],
    approvedInput: { operationRef: operation.operationRef, dataSchema: EXAMPLE_COMPUTE_DATA_SCHEMA },
    profileBindings: [computeBindingFor(operation, input.version)],
    primary: { operationRef: operation.operationRef, registeredOperationDigest: registeredOperationDigest(operation) },
  }
}
