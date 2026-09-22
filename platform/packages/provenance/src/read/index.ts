/**
 * On-demand provenance read side (SPEC C3.1/C6, D3, US-017/US-022, FR-19/FR-20/FR-30).
 *
 * The module resolves an authorized evidence item into its rule/premise/source trace with an
 * explicit re-readability flag, a bounded and honestly truncated dependency traversal, and a
 * controlled export. It receives the evidence archive, the blob port, the byte reader and the
 * real support-DAG dependency source by construction injection and never imports an adapter.
 */
export { ProvenanceReadService } from './read-service'
export type { EvidenceDependencySource, ProvenanceReadServiceDependencies } from './read-service'
export { ProvenanceReadError, isProvenanceReadError } from './errors'
export type { ProvenanceReadErrorCode } from './errors'
export { decodeCursor, encodeCursor } from './cursor'
