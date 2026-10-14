import type { BlobGetAuthorizedRequest, CandidateRecord, ProjectMappingStore, RuleStructuredPremiseSourcePort, StructuredCandidateSourceSpan, StructuredIngestionStore, ToolContext } from '@ontology/contracts'
import { readReconciledRow } from './reconciled-row'
import { sha256DigestOfBytes } from '../hashing'

export interface StructuredPremiseSourceReaderDependencies {
  readonly artifacts: {
    getAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<{ readonly integrityVerified: boolean; readonly byteSize: number }>
    readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
  }
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly ingestion: Pick<StructuredIngestionStore, 'getParse'>
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
    // A relation retains the from-endpoint's documentVersionRef while its source pins
    // cover both endpoints. Each span's own mapping, not that single ref, pins its original.
    // Parse records are content-addressed and may be reused for another logical original ref
    // with identical bytes. Resolve the candidate's exact parse id, but authorize and re-read
    // the current mapping's original below; cached original identifiers are not authority.
    const parse = await this.dependencies.ingestion.getParse(scope, span.parseId, ctx)
    if (parse === undefined || parse.scopeRef.tenantId !== scope.tenantId || parse.scopeRef.spaceId !== scope.spaceId || parse.originalRef.kind !== 'document' ||
      parse.originalRef.digest !== mapping.originalRef.digest || parse.parserVersion !== candidate.inputVersion.parserVersion ||
      parse.parseId !== span.parseId || parse.status !== 'complete' || parse.coverage.completeness !== 'complete' || parse.counts.pending !== 0 || parse.counts.failed !== 0 || parse.counts.skipped !== 0) return undefined
    const request = { scopeRef: scope, blobRef: mapping.originalRef }
    const metadata = await this.dependencies.artifacts.getAuthorized(request, ctx)
    if (!metadata.integrityVerified || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > 8 * 1024 * 1024) return undefined
    const bytes = await this.dependencies.artifacts.readAuthorized(request, ctx)
    if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== mapping.originalRef.digest) return undefined
    const result = readReconciledRow(parse, mapping.originalRef, mapping.options, bytes, scope, span)
    if (result === undefined) return undefined
    return { documentRef: mapping.originalRef, documentVersionRef: mapping.originalRef, parserVersion: parse.parserVersion, rowText: result.rowText }
  }
}
