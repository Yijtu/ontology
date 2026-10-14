import { sha256DigestOf } from '@ontology/core'
import type { SourceRef, VersionRef } from '@ontology/contracts'

/** Kernel constants shared by the Core composition assembly modules. */

export const CONTRACT_SCHEMA_BASE = 'https://ontology.local/schema'
export const COMPONENT_VERSION = '1.0.0'
export const CORE_POLICY_REF: VersionRef = {
  id: 'core-local-policy',
  version: COMPONENT_VERSION,
  digest: sha256DigestOf('core-local-policy@1.0.0'),
}
export const WORKER_RUN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
export const MAX_IMPORTED_BYTES = 1_048_576
export const FACTS_SOURCE_REF: SourceRef = { namespace: 'ontology-core-local', sourceId: 'published-semantic-read' }
export const CORE_EFFECTIVE_LIMITS_REF: VersionRef = {
  id: 'core-local-effective-limits',
  version: COMPONENT_VERSION,
  digest: sha256DigestOf('core-local-effective-limits@1.0.0'),
}

/**
 * The result format the Core host can render and finalize: a `typed-result-manifest@1`. A
 * published task binding whose `resultSchemaRef` is not this registered format is reported as
 * not available by preflight, so no run can claim a formal result the host cannot produce.
 */
export const CORE_TYPED_RESULT_SCHEMA_REF: VersionRef = {
  id: 'typed-result-manifest',
  version: '1.0.0',
  digest: sha256DigestOf('typed-result-manifest@1'),
}
