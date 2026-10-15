import type { Rfc3339UtcTimestamp, ScopeRef } from './generated/contracts'
import { isRecord, isUuid } from './asset-workspace'

/**
 * The source-capability projection (design §2.1/§2.5, A-R01/A-R04). Each intake entry point
 * advertises the formats and caps it accepts and whether it can research, archive or generate, so
 * the UI can show a restriction instead of failing late. An unavailable entry carries a concrete
 * reason and is never presented as usable.
 */
export type SourceEntryPoint = 'ai_research' | 'upload' | 'structured_file'

export interface SourceEntryCapability {
  readonly entry: SourceEntryPoint
  readonly displayName: string
  /** Canonical media/extension tokens the entry accepts, e.g. `text/csv`, `xlsx`. */
  readonly supportedFormats: readonly string[]
  /** Maximum accepted original bytes, when the entry is bounded. */
  readonly maxBytes?: number
  /** Maximum accepted data rows for tabular entries, when bounded. */
  readonly maxRows?: number
  readonly canResearch: boolean
  readonly canArchive: boolean
  readonly canGenerate: boolean
  /** Present when the entry cannot be used; the UI shows it rather than a bare disabled control. */
  readonly unavailableReason?: string
}

export interface SourceCapabilityProjection {
  readonly schemaVersion: 'source-capability-projection@1'
  readonly scopeRef: ScopeRef
  readonly entries: readonly SourceEntryCapability[]
  readonly asOf: Rfc3339UtcTimestamp
}

export const SOURCE_ENTRY_POINTS: readonly SourceEntryPoint[] = ['ai_research', 'upload', 'structured_file']

export function assertSourceCapabilityProjectionShape(value: unknown): asserts value is SourceCapabilityProjection {
  if (!isRecord(value) || value.schemaVersion !== 'source-capability-projection@1'
    || !isRecord(value.scopeRef) || !isUuid(value.scopeRef.tenantId) || !isUuid(value.scopeRef.spaceId)
    || typeof value.asOf !== 'string' || !Array.isArray(value.entries)
    || value.entries.some((entry) => !isRecord(entry)
      || !SOURCE_ENTRY_POINTS.includes(entry['entry'] as SourceEntryPoint)
      || typeof entry['displayName'] !== 'string' || entry['displayName'].length === 0
      || !Array.isArray(entry['supportedFormats']) || !entry['supportedFormats'].every((format) => typeof format === 'string' && format.length > 0)
      || (entry['maxBytes'] !== undefined && (!Number.isSafeInteger(entry['maxBytes']) || (entry['maxBytes'] as number) < 1))
      || (entry['maxRows'] !== undefined && (!Number.isSafeInteger(entry['maxRows']) || (entry['maxRows'] as number) < 1))
      || typeof entry['canResearch'] !== 'boolean' || typeof entry['canArchive'] !== 'boolean' || typeof entry['canGenerate'] !== 'boolean'
      || (entry['unavailableReason'] !== undefined && (typeof entry['unavailableReason'] !== 'string' || entry['unavailableReason'].length === 0)))) {
    throw new SourceCapabilityError('INVALID_REQUEST', 'invalid source capability projection')
  }
}

export type SourceCapabilityErrorCode = 'INVALID_REQUEST'

export class SourceCapabilityError extends Error {
  constructor(readonly code: SourceCapabilityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceCapabilityError'
  }
}

/** Read-only projection port; it returns the caller's own scope only. */
export interface SourceCapabilityReader {
  readCapabilities(scopeRef: ScopeRef): Promise<SourceCapabilityProjection>
}
