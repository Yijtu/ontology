import { CONTROLLER_SERVICE_IDS, TOOL_CATALOGUE, findRegisteredOperation } from '@ontology/contracts'
import type {
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  ResolvedProfile,
  ToolDefinition,
  ToolId,
} from '@ontology/contracts'
import { ToolGatewayError } from './errors'
import { isRecord } from './envelope'
import type { EnabledTool, ToolSchemaValidator } from './types'

function operationKey(ref: OperationRef): string {
  return `${ref.id}@${ref.version}`
}

/**
 * ADR-04: `verify_result` and `final_answer` are controller services, never model
 * tools. A catalogue that listed one of them would let a model invoke the controller
 * path directly, so the gateway refuses to start with such a catalogue instead of
 * silently dropping the entry.
 */
export function assertCatalogueExcludesControllerServices(
  catalogue: readonly ToolDefinition[],
): void {
  const controllerIds: readonly string[] = CONTROLLER_SERVICE_IDS
  for (const definition of catalogue) {
    if (controllerIds.includes(definition.toolId)) {
      throw new ToolGatewayError(
        'CONTROLLER_SERVICE_NOT_CALLABLE',
        `the tool catalogue lists the controller service ${definition.toolId}; controller services are not model tools`,
      )
    }
  }
}

/**
 * Resolve the callable tool set for a run's resolved profile.
 *
 * A tool is callable only when it exists in the canonical catalogue *and* the resolved
 * profile enables it. The canonical catalogue is the closed set of four; a profile can
 * only narrow it, so an unlisted or disabled tool is rejected rather than added.
 */
export function resolveEnabledTools(
  profile: ResolvedProfile,
  catalogue: readonly ToolDefinition[] = TOOL_CATALOGUE,
): readonly EnabledTool[] {
  assertCatalogueExcludesControllerServices(catalogue)
  const enabled: EnabledTool[] = []
  for (const definition of catalogue) {
    const binding = profile.toolBindings.find((candidate) => candidate.toolId === definition.toolId)
    if (binding === undefined || !binding.enabled) continue
    enabled.push({
      definition,
      binding:
        binding.maxCallsPerRun === undefined
          ? { enabled: true }
          : { enabled: true, maxCallsPerRun: binding.maxCallsPerRun },
    })
  }
  return enabled
}

export function findEnabledTool(
  profile: ResolvedProfile,
  toolId: ToolId,
  catalogue: readonly ToolDefinition[] = TOOL_CATALOGUE,
): EnabledTool | undefined {
  return resolveEnabledTools(profile, catalogue).find(
    (candidate) => candidate.definition.toolId === toolId,
  )
}

/**
 * Whether the resolved profile enabled this compute operation. A registered operation
 * that the profile did not bind (or bound with `enabled: false`) cannot execute even
 * with correct parameters (C4/ADR-11).
 */
export function isEnabledOperation(profile: ResolvedProfile, ref: OperationRef): boolean {
  return profile.computeBindings.some(
    (binding) => binding.enabled && operationKey(binding.operationRef) === operationKey(ref),
  )
}

export { operationKey }

/**
 * ADR-11: resolve `data_query.kind=compute` against the *registered* operations.
 *
 * The operation must exist with the exact version and the caller's declared input-schema
 * digest, the resolved profile must have enabled it, and the typed parameters must
 * validate against the operation's own input schema. An unregistered operation is
 * rejected even when its parameters are well-formed, and there is no `code` or script
 * field to fall back on.
 */
export function resolveComputeOperation(
  args: Readonly<Record<string, unknown>>,
  profile: ResolvedProfile,
  registry: OperationRegistry,
  validator: ToolSchemaValidator,
): RegisteredOperation {
  const operationRefValue = args.operationRef
  const digest = args.inputSchemaDigest
  const parameters = args.parameters
  if (
    !isRecord(operationRefValue) ||
    typeof operationRefValue.id !== 'string' ||
    typeof operationRefValue.version !== 'string' ||
    typeof digest !== 'string' ||
    !isRecord(parameters)
  ) {
    throw new ToolGatewayError(
      'INVALID_ARGUMENTS',
      'a compute call requires operationRef{id,version}, inputSchemaDigest and typed parameters',
    )
  }
  const operationRef: OperationRef = { id: operationRefValue.id, version: operationRefValue.version }

  const operation = findRegisteredOperation(registry, operationRef, digest)
  if (operation === undefined) {
    throw new ToolGatewayError(
      'UNKNOWN_COMPUTE_OPERATION',
      `operation ${operationKey(operationRef)} is not registered with input schema digest ${digest}`,
      {
        fieldErrors: [
          { pointer: '/operationRef', reason: 'operation is not registered for this deployment' },
        ],
      },
    )
  }
  if (!isEnabledOperation(profile, operationRef)) {
    throw new ToolGatewayError(
      'OPERATION_NOT_ENABLED',
      `operation ${operationKey(operationRef)} is not enabled by the resolved profile`,
      { fieldErrors: [{ pointer: '/operationRef', reason: 'operation is not enabled by this profile' }] },
    )
  }

  const validation = validator.validateInline(operation.inputSchema, parameters)
  if (!validation.valid) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'compute parameters do not match the registered operation schema', {
      fieldErrors: validation.issues.map((issue) => ({
        pointer: `/parameters${issue.pointer === '' ? '' : issue.pointer}`,
        reason: issue.reason,
      })),
    })
  }
  return operation
}
