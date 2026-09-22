/**
 * Explicit configuration ledger for the X01–X08 replaceability matrix (V2, SPEC §11).
 *
 * The conformance suite must report every externally unverified module as
 * `not_configured` rather than silently passing it. This module is the single source of
 * truth for that ledger: the spec asserts that the suite's report matches it, so a module
 * cannot move from "unverified" to "passed" by accident.
 *
 * "Configured" here means a real implementation exists in the first phase and is exercised
 * by this suite (or by a named real integration suite). "not_configured" means the SPEC
 * explicitly defers it (§11 open items); it is never treated as a passed acceptance.
 */

export type ModuleConfigurationState = 'configured' | 'not_configured'

export type ModuleKind =
  | 'agent_runtime'
  | 'data_backend'
  | 'blob_backend'
  | 'search_backend'
  | 'model_endpoint'
  | 'transport'
  | 'device_driver'

export interface ExternalModuleDeclaration {
  readonly moduleId: string
  readonly kind: ModuleKind
  readonly state: ModuleConfigurationState
  readonly reason: string
}

/**
 * First-phase real modules. Each is exercised by a named real combination in this suite;
 * the SPEC §2.2 line names exactly these as the decoupling acceptance implementations.
 */
export const CONFIGURED_MODULES: readonly ExternalModuleDeclaration[] = [
  {
    moduleId: 'runtime-pi',
    kind: 'agent_runtime',
    state: 'configured',
    reason: 'real Pi Agent Core runtime adapter (LOCAL-018), exercised by X-01',
  },
  {
    moduleId: 'runtime-template',
    kind: 'agent_runtime',
    state: 'configured',
    reason: 'real template runtime adapter (LOCAL-017), exercised by X-01',
  },
  {
    moduleId: 'data-postgres',
    kind: 'data_backend',
    state: 'configured',
    reason: 'real read-only PostgreSQL backend (LOCAL-012), exercised by X-03',
  },
  {
    moduleId: 'data-duckdb',
    kind: 'data_backend',
    state: 'configured',
    reason: 'real sandboxed DuckDB backend (LOCAL-013), exercised by X-03',
  },
  {
    moduleId: 'transport-local',
    kind: 'transport',
    state: 'configured',
    reason: 'real in-process local tool registration (LOCAL-011), exercised by X-02',
  },
  {
    moduleId: 'transport-mcp-stdio',
    kind: 'transport',
    state: 'configured',
    reason: 'real stdio MCP path (LOCAL-014), exercised by X-02',
  },
  {
    moduleId: 'blob-local',
    kind: 'blob_backend',
    state: 'configured',
    reason: 'real immutable local blob store; the first-phase BlobPort implementation',
  },
  {
    moduleId: 'model-company-double',
    kind: 'model_endpoint',
    state: 'configured',
    reason: 'controlled in-process company generation double (no paid call), exercised by X-05',
  },
  {
    moduleId: 'model-jev-double',
    kind: 'model_endpoint',
    state: 'configured',
    reason: 'controlled in-process JEV decision double (no paid call), exercised by X-05',
  },
]

/**
 * External modules the SPEC §11 keeps open. They must be surfaced as `not_configured`
 * by the conformance report; none of them may be reported as a passed case.
 */
export const NOT_CONFIGURED_MODULES: readonly ExternalModuleDeclaration[] = [
  {
    moduleId: 'data-ha',
    kind: 'device_driver',
    state: 'not_configured',
    reason: 'no live Home Assistant driver; simulation is the default (SPEC §11, E7)',
  },
  {
    moduleId: 'blob-s3',
    kind: 'blob_backend',
    state: 'not_configured',
    reason: 'S3 blob is not deployed in the first phase; blob-local is the real backend',
  },
  {
    moduleId: 'search-vector',
    kind: 'search_backend',
    state: 'not_configured',
    reason: 'vector/hybrid retrieval is not implemented; keyword BM25 is the real path',
  },
  {
    moduleId: 'data-starrocks',
    kind: 'data_backend',
    state: 'not_configured',
    reason: 'StarRocks is a not-ready plugin and not a first-phase deployment (SPEC §11)',
  },
  {
    moduleId: 'data-iceberg',
    kind: 'data_backend',
    state: 'not_configured',
    reason: 'Iceberg is a not-ready plugin and not a first-phase deployment (SPEC §11)',
  },
  {
    moduleId: 'search-milvus',
    kind: 'search_backend',
    state: 'not_configured',
    reason: 'Milvus is a not-ready plugin and not a first-phase deployment (SPEC §11)',
  },
  {
    moduleId: 'model-company-endpoint',
    kind: 'model_endpoint',
    state: 'not_configured',
    reason: 'real company generation endpoint/quota is not authorized; CI uses a controlled double',
  },
  {
    moduleId: 'model-jev-endpoint',
    kind: 'model_endpoint',
    state: 'not_configured',
    reason: 'real JEV endpoint/quota is not authorized; CI uses a controlled double',
  },
  {
    moduleId: 'transport-mcp-http',
    kind: 'transport',
    state: 'not_configured',
    reason: 'Streamable HTTP / remote MCP is defined but not enabled before auth and disconnect tests (C5)',
  },
]

export const ALL_MODULES: readonly ExternalModuleDeclaration[] = [
  ...CONFIGURED_MODULES,
  ...NOT_CONFIGURED_MODULES,
]

const BY_ID = new Map(ALL_MODULES.map((module) => [module.moduleId, module]))

/** The state of a declared module; throws for an unknown id so a typo cannot pass silently. */
export function configurationStateOf(moduleId: string): ModuleConfigurationState {
  const declared = BY_ID.get(moduleId)
  if (declared === undefined) throw new Error(`unknown module "${moduleId}" in the configuration ledger`)
  return declared.state
}

export function notConfiguredModules(): readonly ExternalModuleDeclaration[] {
  return NOT_CONFIGURED_MODULES
}

/** The X-cases the suite actually exercises with real adapters (V2 X01–X08). */
export type ConformanceCaseId = 'X-01' | 'X-02' | 'X-03' | 'X-04' | 'X-05' | 'X-06' | 'X-07' | 'X-08'

export interface ConformanceCaseReport {
  readonly caseId: ConformanceCaseId
  readonly state: ModuleConfigurationState
  readonly summary: string
  readonly reason: string
}

export const X_CASE_REPORT: readonly ConformanceCaseReport[] = [
  {
    caseId: 'X-01',
    state: 'configured',
    summary: 'Pi vs Template runtime on the same scenario through the same contract suite',
    reason: 'both runtimes are real adapters (LOCAL-017/018); a controlled generation double stands in for the model',
  },
  {
    caseId: 'X-02',
    state: 'configured',
    summary: 'local vs stdio MCP for the same real data_query domain tool',
    reason: 'both transports share the real gateway, handlers and budget (LOCAL-011/014)',
  },
  {
    caseId: 'X-03',
    state: 'configured',
    summary: 'PostgreSQL vs DuckDB on the same semantic fixture',
    reason: 'both SQL backends are real adapters (LOCAL-012/013) over the same canonical rows',
  },
  {
    caseId: 'X-04',
    state: 'configured',
    summary: 'home-energy vs no-industry direct query and a second declaration pack',
    reason: 'the same core path runs both configurations; the second pack is declared but not mature',
  },
  {
    caseId: 'X-05',
    state: 'configured',
    summary: 'company generation vs a controlled stub; JEV replaced independently',
    reason: 'both ports are separate real adapters; the suite calls controlled doubles and marks them',
  },
  {
    caseId: 'X-06',
    state: 'configured',
    summary: 'device/source naming A vs naming B, changing only the mapping',
    reason: 'two real mappings compile the same semantic plan to equal canonical rows',
  },
  {
    caseId: 'X-07',
    state: 'configured',
    summary: 'profile v1 vs v2 on a new run without touching an old run',
    reason: 'the real upgrade service publishes a new profile version and pins the old manifest',
  },
  {
    caseId: 'X-08',
    state: 'configured',
    summary: 'incompatible capability combinations fail with an explicit typed error',
    reason: 'preflight lists the missing capability and never widens tools/network/write access',
  },
]

/**
 * Backend-irrelevant formatting differences the contract comparison deliberately tolerates.
 * Everything else — authorization, error code, canonical rows/columns, coverage and the
 * logical evidence digest — must be equal.
 */
export const ALLOWED_FORMATTING_DIFFERENCES: readonly string[] = [
  'callId / runId / execution attempt ids (identity is not part of logical evidence)',
  'wall-clock readAt / observedAt / asOf timestamps',
  'transport-specific SQL dialect text and placeholder syntax (? vs $n)',
  'warning message wording when the warning code is the same',
  'resultDigest of a backend snapshot may differ when the physical representation differs, ' +
    'provided the canonical rows and columns are equal (X-03 compares canonical rows directly)',
  'source identity and logical evidence digest when two mappings bind different physical ' +
    'source objects (X-06); the canonical rows and evidence count must still be equal',
]

export function assertNoModuleReportedAsPassed(moduleIds: readonly string[]): void {
  for (const moduleId of moduleIds) {
    if (configurationStateOf(moduleId) !== 'not_configured') {
      throw new Error(`module "${moduleId}" is expected to be not_configured`)
    }
  }
}
