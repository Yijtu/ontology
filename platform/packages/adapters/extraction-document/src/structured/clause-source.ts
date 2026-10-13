import type { BlobGetAuthorizedRequest, RuleStructuredPolicySourcePort, ScopeRef, StructuredCandidateSourceSpan, StructuredIngestionStore, ToolContext } from '@ontology/contracts'
import { readReconciledRow } from './reconciled-row'
import { sha256DigestOfBytes } from '../hashing'

export interface StructuredClauseSourceReaderDependencies {
  readonly artifacts: {
    getAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<{ readonly integrityVerified: boolean; readonly byteSize: number }>
    readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
  }
  readonly ingestion: Pick<StructuredIngestionStore, 'getParse'>
}

/**
 * Authorized read of one authored original row/cell used as a rule/action clause basis. Unlike the
 * fact-premise reader it needs no project mapping: the workspace-approved structured source carries
 * its own parse pin, so the parse record alone resolves the original. A parse without captured
 * options fails closed (the exact selection cannot be reproduced, so the row cannot be re-derived).
 */
export class StructuredClauseSourceReader implements RuleStructuredPolicySourcePort {
  constructor(readonly dependencies: StructuredClauseSourceReaderDependencies) {}
  async read(span: StructuredCandidateSourceSpan, ctx: ToolContext): ReturnType<RuleStructuredPolicySourcePort['read']> {
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const parse = await this.dependencies.ingestion.getParse(scope, span.parseId, ctx)
    if (parse === undefined || parse.scopeRef.tenantId !== scope.tenantId || parse.scopeRef.spaceId !== scope.spaceId ||
      parse.originalRef.kind !== 'document' || parse.parseId !== span.parseId || parse.status !== 'complete' ||
      parse.coverage.completeness !== 'complete' || parse.counts.pending !== 0 || parse.counts.failed !== 0 || parse.counts.skipped !== 0 ||
      parse.parseOptions === undefined) return undefined
    const request = { scopeRef: scope, blobRef: parse.originalRef }
    const metadata = await this.dependencies.artifacts.getAuthorized(request, ctx)
    if (!metadata.integrityVerified || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > 8 * 1024 * 1024) return undefined
    const bytes = await this.dependencies.artifacts.readAuthorized(request, ctx)
    if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== parse.originalRef.digest) return undefined
    const read = readReconciledRow(parse, parse.originalRef, parse.parseOptions, bytes, scope, span)
    if (read === undefined) return undefined
    return { documentRef: parse.originalRef, documentVersionRef: parse.documentVersionRef ?? parse.originalRef, parserVersion: parse.parserVersion, sourceCoverage: parse.coverage, rowText: read.rowText }
  }
}
