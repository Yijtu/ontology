import type {
  DataMode,
  DomainResultStatus,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Sha256Digest,
  ToolCoverage,
  Uuid,
} from './generated/contracts'
import type { PublicationKind } from './workflow'
import type { TableColumnDescriptor } from './typed-results'
import { isRecord, isResourceRef, isSha256Digest, isUuid } from './asset-workspace'

/**
 * Structured JSON export of a verified result (SPEC v0.3a execution-evidence §EX-9,
 * asset-data-ui §9.2/§9.3, issue V03-041 / #214, A.US-014.AC-03 / A.FR-22).
 *
 * The export is a *read projection* of the exact published answer version and the exact
 * archived typed-result manifest that version pins. It is not a second representation of
 * the result: it carries the same `contentHash`, the same `resultManifestRef`/digest and the
 * same table descriptors the verified page renders, so an export can never silently reflect
 * a later edit. A later edit is a new draft, a new verification and a new answer version;
 * exporting again then yields a new export bound to the new version.
 *
 * The access rules are exactly those of the verified page: the export is only produced after
 * the same scoped, digest-verified read that serves the page, so a caller who cannot read
 * the verified result cannot export it either. A professional XLSX template is registered by
 * the scenario (B's node) and is not defined here.
 */
export const VERIFIED_RESULT_EXPORT_SCHEMA_VERSION = 'verified-result-export@1'

/** Which part of the verified result bound an evidence entry into the export source index. */
export type ResultSourceBindingKind = 'claim' | 'assertion'

/** One archived table of the exported version, with its page refs and verification receipt. */
export interface VerifiedResultExportTable {
  readonly tableId: string
  readonly totalRows: number
  readonly columns: readonly TableColumnDescriptor[]
  readonly complete: boolean
  readonly manifestRef: ResourceRef
  readonly manifestDigest: Sha256Digest
  readonly pageRefs: readonly ResourceRef[]
  readonly verificationReceiptRef?: ResourceRef
}

/**
 * One entry of the source index: the exact evidence result the verified body was bound to,
 * and which body part referenced it. The result index never invents a source; it is derived
 * only from the hash-bound claims/assertions of the exported answer version.
 */
export interface VerifiedResultExportSource {
  readonly evidenceId: Uuid
  readonly evidenceRef: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly boundBy: readonly ResultSourceBindingKind[]
}

/** The version identity of the exported verified result. */
export interface VerifiedResultExportVersions {
  readonly answerId: Uuid
  readonly runId: Uuid
  readonly contentHash: Sha256Digest
  readonly verificationId: Uuid
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly executionBindingRef: ResourceRef
  readonly finalizationReceiptRef: ResourceRef
  readonly finalizationReceiptDigest: Sha256Digest
}

/** The status projection of the exported verified result, separate from its version identity. */
export interface VerifiedResultExportStatus {
  readonly publicationKind: PublicationKind
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
  readonly currentValidity: {
    readonly state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
    readonly reason?: string
  }
  readonly coverage: ToolCoverage
  readonly limitations: readonly string[]
}

/** The full structured JSON export of one verified result version. */
export interface VerifiedResultExport {
  readonly schemaVersion: 'verified-result-export@1'
  readonly exportedAt: Rfc3339UtcTimestamp
  readonly status: VerifiedResultExportStatus
  readonly versions: VerifiedResultExportVersions
  readonly tables: readonly VerifiedResultExportTable[]
  readonly sourceIndex: readonly VerifiedResultExportSource[]
}

function isCoverage(value: unknown): value is ToolCoverage {
  return isRecord(value) && typeof value['returned'] === 'number' && typeof value['truncated'] === 'boolean'
}

function isValidity(value: unknown): value is VerifiedResultExportStatus['currentValidity'] {
  return (
    isRecord(value) &&
    (value['state'] === 'current' ||
      value['state'] === 'superseded' ||
      value['state'] === 'withdrawn' ||
      value['state'] === 'unverifiable') &&
    (value['reason'] === undefined || typeof value['reason'] === 'string')
  )
}

function isColumn(value: unknown): value is TableColumnDescriptor {
  return (
    isRecord(value) &&
    typeof value['columnRef'] === 'string' &&
    value['columnRef'].length > 0 &&
    typeof value['semanticPredicate'] === 'string' &&
    typeof value['valueType'] === 'string' &&
    typeof value['schemaPointer'] === 'string'
  )
}

function isTable(value: unknown): value is VerifiedResultExportTable {
  return (
    isRecord(value) &&
    typeof value['tableId'] === 'string' &&
    value['tableId'].length > 0 &&
    typeof value['totalRows'] === 'number' &&
    Array.isArray(value['columns']) &&
    value['columns'].every(isColumn) &&
    typeof value['complete'] === 'boolean' &&
    isResourceRef(value['manifestRef']) &&
    isSha256Digest(value['manifestDigest']) &&
    Array.isArray(value['pageRefs']) &&
    value['pageRefs'].every(isResourceRef) &&
    (value['verificationReceiptRef'] === undefined || isResourceRef(value['verificationReceiptRef']))
  )
}

function isSource(value: unknown): value is VerifiedResultExportSource {
  return (
    isRecord(value) &&
    isUuid(value['evidenceId']) &&
    isResourceRef(value['evidenceRef']) &&
    isSha256Digest(value['resultDigest']) &&
    Array.isArray(value['boundBy']) &&
    value['boundBy'].every((entry) => entry === 'claim' || entry === 'assertion')
  )
}

/**
 * Runtime guard for the exported verified result. The export crosses the wire (HTTP → browser
 * download) so the reader validates it instead of trusting a TypeScript assertion.
 */
export function isVerifiedResultExport(value: unknown): value is VerifiedResultExport {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== VERIFIED_RESULT_EXPORT_SCHEMA_VERSION) return false
  if (typeof value['exportedAt'] !== 'string') return false
  const status = value['status']
  if (
    !isRecord(status) ||
    (status['publicationKind'] !== 'verified' && status['publicationKind'] !== 'history_limited') ||
    typeof status['domainStatus'] !== 'string' ||
    typeof status['dataMode'] !== 'string' ||
    !isValidity(status['currentValidity']) ||
    !isCoverage(status['coverage']) ||
    !Array.isArray(status['limitations']) ||
    !status['limitations'].every((entry) => typeof entry === 'string')
  ) {
    return false
  }
  const versions = value['versions']
  if (
    !isRecord(versions) ||
    !isUuid(versions['answerId']) ||
    !isUuid(versions['runId']) ||
    !isSha256Digest(versions['contentHash']) ||
    !isUuid(versions['verificationId']) ||
    !isResourceRef(versions['resultManifestRef']) ||
    !isSha256Digest(versions['resultManifestDigest']) ||
    !isResourceRef(versions['executionBindingRef']) ||
    !isResourceRef(versions['finalizationReceiptRef']) ||
    !isSha256Digest(versions['finalizationReceiptDigest'])
  ) {
    return false
  }
  return (
    Array.isArray(value['tables']) &&
    value['tables'].every(isTable) &&
    Array.isArray(value['sourceIndex']) &&
    value['sourceIndex'].every(isSource)
  )
}
