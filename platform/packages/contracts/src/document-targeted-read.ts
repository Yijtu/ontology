import type {
  ByteSize,
  DocumentSpan,
  OpaqueCursor,
  ResourceRef,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import { isRecord, isResourceRef, isSha256Digest, isUuid } from './asset-workspace'
import type { ToolContext } from './trusted'

/**
 * The versioned targeted-read mode of `document_search` (design §6).
 *
 * The four-tool catalogue is unchanged: `document_search` gains a **targeted read** mode that lets
 * the agent continue reading a document it already found, instead of re-running a keyword search on
 * an ever-growing recap. A request names an already-authorized document (and optionally a span and
 * the exact parse it is grounded in) and is bounded by a cursor, a page size and a byte cap.
 *
 * The result binds every returned span to its document version/locator/quote digest/parser
 * version, states whether it came from the ready index or a direct archive read (`indexState`
 * distinguishes "the index is not built yet" from "the document has no content"), and returns
 * truncation explicitly. It never returns a whole document.
 */

export type DocumentTargetedReadIndexState = 'indexed' | 'not_indexed_readable' | 'unavailable'

export type DocumentTargetedReadReason =
  | 'not_authorized'
  | 'parse_not_ready'
  | 'empty'
  | 'byte_limit'
  | 'unsupported_media_type'
  | 'cancelled'

export interface DocumentTargetedSelection {
  /** The exact authorized document version to read. */
  readonly documentRef: ResourceRef
  /** An optional in-document span; absent reads from the start (or the cursor position). */
  readonly locator?: DocumentSpan['locator']
  /** The exact parse the caller is grounded in; absent reads the current authorized parse. */
  readonly parseId?: Uuid
}

export interface DocumentTargetedReadRequest {
  readonly schemaVersion: 'document-targeted-read@1'
  readonly workspaceId: Uuid
  /** The authorized documents/spans to read, bounded. */
  readonly selections: readonly DocumentTargetedSelection[]
  readonly cursor?: OpaqueCursor
  /** Maximum bytes returned across the page; the reader never exceeds it. */
  readonly maxBytes: ByteSize
  /** Bounded page size (number of returned spans). */
  readonly limit: number
}

/** One returned span: readable text plus the exact locator it was read from. */
export interface DocumentTargetedReadItem {
  readonly documentRef: ResourceRef
  readonly locator: DocumentSpan['locator']
  readonly parserVersion: Semver
  readonly quoteDigest: Sha256Digest
  readonly textDigest: Sha256Digest
  /** The readable preview, bounded by the request byte cap. */
  readonly text: string
  readonly truncated: boolean
  readonly indexState: DocumentTargetedReadIndexState
  readonly unavailableReason?: DocumentTargetedReadReason
}

export interface DocumentTargetedReadUsage {
  readonly bytes: ByteSize
  readonly documents: number
}

export interface DocumentTargetedReadResult {
  readonly schemaVersion: 'document-targeted-read-result@1'
  readonly items: readonly DocumentTargetedReadItem[]
  readonly nextCursor?: OpaqueCursor
  readonly truncated: boolean
  readonly usage: DocumentTargetedReadUsage
}

/**
 * The versioned targeted-read port (design §6). An implementation resolves each already-authorized
 * selection to its exact parse, returns span text bound to its document version/locator/quote
 * digest/parser version, and — crucially — reports whether a selection came from the ready index
 * or a direct read of the archived parse. When the index is not built yet the archived parse is
 * still readable, so "not indexed" is never reported as "no content".
 */
export interface DocumentTargetedReaderPort {
  read(request: DocumentTargetedReadRequest, ctx: ToolContext): Promise<DocumentTargetedReadResult>
}

export type DocumentTargetedReadErrorCode = 'INVALID_REQUEST' | 'SCOPE_MISMATCH' | 'NOT_FOUND' | 'READ_FAILED'

export class DocumentTargetedReadError extends Error {
  constructor(readonly code: DocumentTargetedReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentTargetedReadError'
  }
}

const INDEX_STATES: readonly DocumentTargetedReadIndexState[] = ['indexed', 'not_indexed_readable', 'unavailable']
const READ_REASONS: readonly DocumentTargetedReadReason[] = [
  'not_authorized', 'parse_not_ready', 'empty', 'byte_limit', 'unsupported_media_type', 'cancelled',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isLocator(value: unknown): value is DocumentSpan['locator'] {
  if (!isRecord(value)) return false
  if (!['page', 'offset', 'approximate_locator'].includes(String(value['kind']))) return false
  if (value['page'] !== undefined && !Number.isSafeInteger(value['page'])) return false
  if (value['startOffset'] !== undefined && !Number.isSafeInteger(value['startOffset'])) return false
  if (value['endOffset'] !== undefined && !Number.isSafeInteger(value['endOffset'])) return false
  return true
}

/** Validate a targeted-read request before any read is attempted. */
export function assertDocumentTargetedReadRequestShape(
  value: unknown,
): asserts value is DocumentTargetedReadRequest {
  if (!isRecord(value) || value['schemaVersion'] !== 'document-targeted-read@1' || !isUuid(value['workspaceId'])
    || !Number.isSafeInteger(value['maxBytes']) || (value['maxBytes'] as number) < 1
    || !Number.isSafeInteger(value['limit']) || (value['limit'] as number) < 1 || (value['limit'] as number) > 64
    || (value['cursor'] !== undefined && !isNonEmptyString(value['cursor']))) {
    throw new DocumentTargetedReadError('INVALID_REQUEST', 'invalid document targeted-read request')
  }
  const selections = value['selections']
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > 16
    || !selections.every((selection) => isRecord(selection)
      && isResourceRef(selection['documentRef'])
      && (selection['locator'] === undefined || isLocator(selection['locator']))
      && (selection['parseId'] === undefined || isUuid(selection['parseId'])))) {
    throw new DocumentTargetedReadError('INVALID_REQUEST', 'a targeted read requires 1..16 authorized document selections')
  }
}

/** Validate a targeted-read result before the runtime renders it. */
export function assertDocumentTargetedReadResultShape(
  value: unknown,
): asserts value is DocumentTargetedReadResult {
  if (!isRecord(value) || value['schemaVersion'] !== 'document-targeted-read-result@1'
    || typeof value['truncated'] !== 'boolean'
    || (value['nextCursor'] !== undefined && !isNonEmptyString(value['nextCursor']))) {
    throw new DocumentTargetedReadError('READ_FAILED', 'invalid document targeted-read result')
  }
  const items = value['items']
  if (!Array.isArray(items) || !items.every((item) => isRecord(item)
    && isResourceRef(item['documentRef']) && isLocator(item['locator'])
    && isNonEmptyString(item['parserVersion'])
    && isSha256Digest(item['quoteDigest']) && isSha256Digest(item['textDigest'])
    && typeof item['text'] === 'string' && typeof item['truncated'] === 'boolean'
    && INDEX_STATES.includes(item['indexState'] as DocumentTargetedReadIndexState)
    && (item['unavailableReason'] === undefined
      || READ_REASONS.includes(item['unavailableReason'] as DocumentTargetedReadReason)))) {
    throw new DocumentTargetedReadError('READ_FAILED', 'invalid document targeted-read item')
  }
  const usage = value['usage']
  if (!isRecord(usage) || !Number.isSafeInteger(usage['bytes']) || (usage['bytes'] as number) < 0
    || !Number.isSafeInteger(usage['documents']) || (usage['documents'] as number) < 0) {
    throw new DocumentTargetedReadError('READ_FAILED', 'invalid document targeted-read usage')
  }
}
