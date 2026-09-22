/**
 * @ontology/tool-services — the unified tool gateway (C4, ADR-04).
 *
 * This service layer owns the fixed execution order (validate → reserve → intent →
 * execute → evidence → settle), the catalogue gating against a run's resolved profile,
 * the trusted-envelope enforcement and the evidence/result archival. It reaches
 * persistence only through injected ports (`BudgetLedgerPort`, `EvidenceStorePort`,
 * `ImmutableArtifactWriter`) and never imports an adapter, a driver or a schema library.
 */
export { ToolGatewayError, isToolGatewayError, toPlatformError } from './errors'
export type { ToolGatewayErrorCode } from './errors'
export { cancellationError, raceWithAbort } from './cancellation'
export {
  assertCatalogueExcludesControllerServices,
  findEnabledTool,
  isEnabledOperation,
  operationKey,
  resolveComputeOperation,
  resolveEnabledTools,
} from './catalogue'
export {
  DEFAULT_RESERVE_ROWS,
  MAX_ARGUMENT_BYTES,
  MAX_ARGUMENT_ITEMS,
  MAX_ARGUMENT_STRING,
  assertBoundedArguments,
  assertNoMaliciousKeys,
  assertRequestedLimit,
  assertTrustedEnvelope,
  estimatedReservationRows,
  isRecord,
} from './envelope'
export { INLINE_RESULT_BYTES, ToolGatewayService, createRunToolGateway } from './gateway'
export type { ToolGatewayDependencies } from './gateway'
export { logicalEvidenceDigest } from './evidence'
export { WebSearchHandler, resolveWebSearchEnablement } from './web-search'
export type {
  WebSearchDisabledReason,
  WebSearchEnablement,
  WebSearchHandlerOptions,
} from './web-search'
export { DataQueryHandler, OntologyLookupHandler } from './handlers'
export type { DataQueryComputeConfig, DataQueryHandlerConfig, OntologyLookupHandlerConfig } from './handlers'
export {
  assertNoComputeBypass,
  computeOutcomeOf,
  computeRequestOf,
  createScopedArtifactReader,
  resolveComputeHandler,
  runComputeWithBudget,
} from './handlers'
export {
  canonicalJson,
  digestOfSchema,
  snapshotFrom,
  toolSchemaRef,
} from './types'
export type {
  EnabledTool,
  RunToolBinding,
  SchemaValidationIssue,
  SchemaValidationResult,
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolHandler,
  ToolSchemaValidator,
  ToolSourceObservation,
} from './types'
