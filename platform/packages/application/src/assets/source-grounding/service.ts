import { SourceGroundingError, assertGroundingDocumentSet, isResourceRef, isToolContext, isUuid } from '@ontology/contracts'
import { readLatestWorkspaceDraft } from '../workspace-draft'
import type { GroundedSource, GroundedSourceContent, GroundingDocumentSetReaderPort,
  IndustryWorkspaceStore, ResourceRef, ScopeRef, SourceGroundingBudgetPort, SourceGroundingPort,
  SourceGroundingReaderPort, SourceGroundingReason, ToolContext } from '@ontology/contracts'

export interface SourceGroundingDependencies {
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace' | 'getDraft' | 'listDrafts' | 'getLatestDraft'>
  readonly documentSets: GroundingDocumentSetReaderPort
  readonly reader: SourceGroundingReaderPort
  readonly pageSize?: number
  readonly sampleRows?: number
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

export function createSourceGroundingService(dependencies: SourceGroundingDependencies): SourceGroundingPort {
  return new SourceGroundingService(dependencies)
}

export class SourceGroundingService implements SourceGroundingPort {
  readonly #pageSize: number
  readonly #sampleRows: number
  constructor(readonly dependencies: SourceGroundingDependencies) {
    this.#pageSize = dependencies.pageSize ?? 8
    this.#sampleRows = dependencies.sampleRows ?? 5
    for (const size of [this.#pageSize, this.#sampleRows]) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 64) {
        throw new SourceGroundingError('INVALID_REQUEST', 'page/sample sizes must be within 1..64')
      }
    }
  }

  async read(request: Parameters<SourceGroundingPort['read']>[0], ctx: ToolContext,
    budget: SourceGroundingBudgetPort): ReturnType<SourceGroundingPort['read']> {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
      throw new SourceGroundingError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
    }
    if (!isUuid(request.workspaceId) || !Array.isArray(request.sourceRefs)
      || request.sourceRefs.length === 0 || request.sourceRefs.length > 256
      || request.sourceRefs.some((ref) => !isResourceRef(ref))
      || new Set(request.sourceRefs.map((ref) => ref.id)).size !== request.sourceRefs.length) {
      throw new SourceGroundingError('INVALID_REQUEST', 'a workspace and bounded unique source references are required')
    }
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const workspace = await this.dependencies.workspaces.getWorkspace(scope, request.workspaceId, ctx)
    if (workspace === undefined || workspace.state === 'archived') {
      throw new SourceGroundingError('NOT_APPROVED', 'workspace is not visible or active')
    }
    const latest = await readLatestWorkspaceDraft(this.dependencies.workspaces, scope, workspace.workspaceId, ctx)
    const draft = request.inputDraftRef === undefined ? latest
      : await this.dependencies.workspaces.getDraft(scope, workspace.workspaceId, request.inputDraftRef.revision, ctx)
    if (request.inputDraftRef !== undefined && (draft?.digest !== request.inputDraftRef.digest || draft?.revision !== request.inputDraftRef.revision
      || request.inputDraftRef.workspaceId !== workspace.workspaceId || latest?.revision !== draft?.revision)) {
      throw new SourceGroundingError('DOCUMENT_SET_CHANGED', 'the requested input draft is not the current pinned corpus')
    }
    if (draft !== undefined && BigInt(draft.revision) > BigInt(workspace.headRevision)) throw new SourceGroundingError('DOCUMENT_SET_CHANGED', 'draft lies beyond the current workspace head')
    if (draft === undefined) throw new SourceGroundingError('NOT_APPROVED', 'workspace has no pinned document set')
    const documentSetRef = draft.documentSetRef
    const failed = (reason: SourceGroundingReason): GroundedSource[] => request.sourceRefs.map((sourceRef) => ({
      sourceRef, trust: 'untrusted_source_data', status: 'failed', reasons: [reason], contents: [],
    }))
    let sources: GroundedSource[] = []
    try {
      budget.check()
      const manifest = await this.dependencies.documentSets.read(scope, documentSetRef, ctx, budget)
      budget.check()
      assertGroundingDocumentSet(manifest)
      if (manifest.workspaceId !== workspace.workspaceId || manifest.scopeRef.tenantId !== scope.tenantId
        || manifest.scopeRef.spaceId !== scope.spaceId) {
        throw new SourceGroundingError('SCOPE_MISMATCH', 'document set does not belong to the trusted workspace scope')
      }
      for (const sourceRef of request.sourceRefs) {
        budget.check()
        const approval = manifest.sources.find((source) => source.sourceRef.id === sourceRef.id)
        const contents: GroundedSourceContent[] = []
        const reasons: SourceGroundingReason[] = []
        if (approval === undefined) reasons.push('NOT_APPROVED')
        else if (!sameRef(approval.sourceRef, sourceRef)) reasons.push('SOURCE_MISMATCH')
        else if (approval.state !== 'approved') reasons.push('SOURCE_RETRACTED')
        else {
          let cursor: string | undefined
          let rows = 0
          try {
            do {
              budget.check()
              if (budget.remainingFragments === 0) { reasons.push('FRAGMENT_LIMIT'); break }
              budget.chargePage()
              const page = await this.dependencies.reader.readPage(scope, approval, {
                limit: Math.min(this.#pageSize, budget.remainingFragments,
                  approval.kind === 'table' ? this.#sampleRows - rows : this.#pageSize),
                ...(cursor === undefined ? {} : { cursor }),
              }, ctx, budget)
              budget.check()
              for (const content of page.contents) {
                const reason = budget.accept(content)
                if (reason !== undefined) { reasons.push(reason); break }
                contents.push(content)
                if (content.kind === 'table') rows += content.rows.length
              }
              reasons.push(...page.reasons)
              if (reasons.length > 0) break
              if (page.nextCursor !== undefined && rows >= this.#sampleRows && approval.kind === 'table') {
                reasons.push('SAMPLE_LIMIT'); break
              }
              if (page.nextCursor !== undefined && (page.nextCursor === cursor || page.contents.length === 0)) {
                throw new SourceGroundingError('READ_FAILED', 'source reader did not advance its page')
              }
              cursor = page.nextCursor
            } while (cursor !== undefined)
          } catch (error) {
            if (error instanceof SourceGroundingError && error.code === 'CANCELLED') throw error
            reasons.push(error instanceof SourceGroundingError ? error.code : 'READ_FAILED')
          }
        }
        if (contents.length === 0 && reasons.length === 0) reasons.push('EMPTY_SOURCE')
        sources.push({ sourceRef, trust: 'untrusted_source_data', contents,
          status: reasons.length === 0 ? 'complete' : contents.length > 0 ? 'partial' : 'failed',
          reasons: [...new Set(reasons)] })
      }
      const current = await this.dependencies.workspaces.getWorkspace(scope, request.workspaceId, ctx)
      budget.check()
      if (current === undefined || current.state === 'archived' || current.headRevision !== workspace.headRevision) {
        sources = failed('DOCUMENT_SET_CHANGED')
      }
    } catch (error) {
      sources = failed(error instanceof SourceGroundingError ? error.code : 'READ_FAILED')
    }
    return { documentSetRef, sources,
      coverage: sources.every((source) => source.status === 'complete') ? 'complete'
        : sources.every((source) => source.status === 'failed') ? 'failed' : 'partial', usage: budget.usage() }
  }
}
