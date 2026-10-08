import type { BlobGetAuthorizedRequest, CandidateRecord, ProjectMappingStore, RuleStructuredPremiseSourcePort, StructuredCandidateSourceSpan, StructuredIngestionStore, ToolContext } from '@ontology/contracts'
import { StructuredDocumentParser } from './index'
import { reconcileStructuredResult } from './ingest-service'
import { sha256DigestOfBytes } from '../hashing'
import { sha256OfCanonical } from '@ontology/contracts'

export interface StructuredPremiseSourceReaderDependencies {
  readonly artifacts: {
    getAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<{ readonly integrityVerified: boolean; readonly byteSize: number }>
    readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
  }
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly ingestion: Pick<StructuredIngestionStore, 'findParseByDigest'>
}

/** Reparse the exact approved original selection and check the row and individual cell locator. */
export class StructuredPremiseSourceReader implements RuleStructuredPremiseSourcePort {
  constructor(readonly dependencies: StructuredPremiseSourceReaderDependencies) {}
  async read(candidate: CandidateRecord, span: StructuredCandidateSourceSpan, ctx: ToolContext): ReturnType<RuleStructuredPremiseSourcePort['read']> {
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const pin = candidate.inputVersion.projectFact?.sources.find((source) => source.parseId === span.parseId)
    if (pin === undefined) return undefined
    const mapping = await this.dependencies.mappings.getMapping(scope, pin.projectRevisionRef.projectId, pin.mappingRef.id, pin.mappingRef.version, ctx)
    if (mapping === undefined || mapping.ref.id !== pin.mappingRef.id || mapping.ref.version !== pin.mappingRef.version || mapping.ref.digest !== pin.mappingRef.digest || mapping.parseId !== span.parseId ||
      mapping.definitionRef.id !== candidate.inputVersion.definitionRef.id || mapping.definitionRef.version !== candidate.inputVersion.definitionRef.version || mapping.definitionRef.digest !== candidate.inputVersion.definitionRef.digest) return undefined
    const parse = await this.dependencies.ingestion.findParseByDigest(scope, mapping.originalRef.digest, candidate.inputVersion.parserVersion, ctx)
    if (parse === undefined || parse.scopeRef.tenantId !== scope.tenantId || parse.scopeRef.spaceId !== scope.spaceId || parse.originalRef.id !== mapping.originalRef.id || parse.originalRef.version !== mapping.originalRef.version || parse.originalRef.digest !== mapping.originalRef.digest ||
      parse.parseId !== span.parseId || parse.status !== 'complete' || parse.coverage.completeness !== 'complete' || parse.counts.pending !== 0 || parse.counts.failed !== 0 || parse.counts.skipped !== 0) return undefined
    const request = { scopeRef: scope, blobRef: mapping.originalRef }
    const metadata = await this.dependencies.artifacts.getAuthorized(request, ctx)
    if (!metadata.integrityVerified || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > 8 * 1024 * 1024) return undefined
    const bytes = await this.dependencies.artifacts.readAuthorized(request, ctx)
    if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== mapping.originalRef.digest) return undefined
    const result = new StructuredDocumentParser().parse(bytes, { ...mapping.options, mediaType: mapping.originalMediaType })
    if (result.status !== 'complete') return undefined
    const entry = reconcileStructuredResult(result, scope, mapping.originalRef.digest).entries.find((row) => row.recordId === span.recordId)
    if (entry === undefined || entry.state !== 'parsed' || entry.rowDigest !== span.rowDigest || entry.sourceRowKey !== span.sourceRowKey) return undefined
    const row = result.tables.flatMap((table) => table.rows).find((row) => row.recordIndex === entry.recordIndex && row.row === entry.row)
    if (row === undefined || ![row.locator, ...row.cells.map((cell) => cell.locator)].some((locator) => sha256OfCanonical(locator) === sha256OfCanonical(span.locator))) return undefined
    return { documentRef: mapping.originalRef, documentVersionRef: parse.documentVersionRef ?? mapping.originalRef, parserVersion: parse.parserVersion,
      rowText: JSON.stringify({ sourceRowKey: entry.sourceRowKey, cells: row.cells.map((cell) => [cell.raw, cell.kind]) }) }
  }
}
