import { SubmitCandidatesError, isToolContext } from '@ontology/contracts'
import type {
  CandidateEvidence,
  CandidateEvidenceContentPort,
  CandidateEvidencePort,
  CandidateEvidenceResolutionRequest,
  ResearchDocumentMember,
  ResearchDocumentSetStore,
  ResourceRef,
  ResolvedCandidateEvidence,
  ScopeRef,
  SourceTrustTier,
  ToolContext,
} from '@ontology/contracts'

/** The bounded number of staged members one evidence resolution may scan. */
const MAX_MEMBER_SCAN = 1000
const MEMBER_PAGE = 200

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

export interface ResearchMaterialReadDependencies {
  /** The run's staged evidence set (design §4/§6); only members staged for this run are readable. */
  readonly members: ResearchDocumentSetStore
  /** Re-reads an archived bytes artifact so a digest is verified, not merely compared. */
  readonly content?: CandidateEvidenceContentPort
}

/**
 * Resolves candidate evidence against the material **this run** already staged (design §4/§7).
 *
 * The model may only reference evidence that was obtained in this execution: an archived page or a
 * located span in an authorized document, both of which the research staging set records bound to
 * `(workspace, run)`. A reference to a page this run never archived, a digest that does not match the
 * staged content, or a parser version that disagrees with the staged parse is rejected outright, so a
 * forged or borrowed snapshot can never ground a candidate (design §7 ②). Staged material is
 * deliberately high-trust-blocking: a research archive is `agent_researched` and stays
 * `pending_confirmation` until a human promotes the source.
 */
export class ResearchMaterialReadService implements CandidateEvidencePort {
  readonly #members: ResearchDocumentSetStore
  readonly #content: CandidateEvidenceContentPort | undefined

  constructor(dependencies: ResearchMaterialReadDependencies) {
    this.#members = dependencies.members
    this.#content = dependencies.content
  }

  async resolve(
    request: CandidateEvidenceResolutionRequest,
    ctx: ToolContext,
  ): Promise<readonly ResolvedCandidateEvidence[]> {
    const scope = scopeOf(ctx)
    const members = await this.#loadMembers(scope, request.workspaceId, request.runId, ctx)
    const resolved: ResolvedCandidateEvidence[] = []
    for (const [index, evidence] of request.evidence.entries()) {
      const member = this.#match(members, evidence)
      if (member === undefined) {
        throw new SubmitCandidatesError(
          'EVIDENCE_NOT_AUTHORIZED',
          `evidence ${String(index)} does not resolve to material this run obtained`,
        )
      }
      if (member.parserVersion !== evidence.parserVersion) {
        throw new SubmitCandidatesError(
          'EVIDENCE_NOT_AUTHORIZED',
          `evidence ${String(index)} parser version disagrees with the staged parse`,
        )
      }
      if (evidence.kind === 'web_page' && member.contentDigest !== evidence.contentDigest) {
        throw new SubmitCandidatesError(
          'EVIDENCE_DIGEST_MISMATCH',
          `evidence ${String(index)} digest does not match the staged content`,
        )
      }
      if (evidence.kind === 'located_span' && member.parseId !== evidence.span.parseId) {
        throw new SubmitCandidatesError(
          'EVIDENCE_NOT_AUTHORIZED',
          `evidence ${String(index)} located span does not belong to the staged parse`,
        )
      }
      const reReadVerified = await this.#verifyRead(evidence, member, ctx)
      const trustTier: SourceTrustTier = member.kind === 'authorized_document' ? 'customer_authoritative' : 'agent_researched'
      resolved.push({
        index,
        sourceRef: member.documentRef,
        ...(evidence.kind === 'located_span' ? { sourceSpan: evidence.span } : {}),
        parserVersion: member.parserVersion,
        contentDigest: member.contentDigest,
        trustTier,
        ...(evidence.kind === 'web_page' ? { url: evidence.url } : {}),
        reReadVerified,
      })
    }
    return resolved
  }

  async #verifyRead(evidence: CandidateEvidence, member: ResearchDocumentMember, ctx: ToolContext): Promise<boolean> {
    if (this.#content === undefined) return false
    const ref = evidence.kind === 'web_page' ? evidence.snapshotRef : member.documentRef
    let read: { readonly bytes: Uint8Array; readonly contentDigest: string }
    try {
      read = await this.#content.read(ref, ctx)
    } catch (error) {
      throw new SubmitCandidatesError('EVIDENCE_NOT_AUTHORIZED', 'the archived evidence bytes could not be re-read', { cause: error })
    }
    if (read.contentDigest !== member.contentDigest) {
      throw new SubmitCandidatesError('EVIDENCE_DIGEST_MISMATCH', 'the re-read archived bytes do not match the staged digest')
    }
    return true
  }

  #match(members: readonly ResearchDocumentMember[], evidence: CandidateEvidence): ResearchDocumentMember | undefined {
    if (evidence.kind === 'web_page') {
      return members.find((member) => member.kind === 'research_archive'
        && ((member.provenanceRef !== undefined && sameRef(member.provenanceRef, evidence.snapshotManifestRef))
          || sameRef(member.documentRef, evidence.snapshotRef)))
    }
    return members.find((member) => sameRef(member.documentRef, evidence.sourceRef) || sameRef(member.parseRef, evidence.sourceRef))
  }

  async #loadMembers(
    scope: ScopeRef,
    workspaceId: string,
    runId: string,
    ctx: ToolContext,
  ): Promise<ResearchDocumentMember[]> {
    const out: ResearchDocumentMember[] = []
    let cursor: string | undefined
    for (let scanned = 0; scanned < MAX_MEMBER_SCAN / MEMBER_PAGE + 1; scanned += 1) {
      const page = await this.#members.listMembers(scope, {
        workspaceId,
        runId,
        limit: MEMBER_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      }, ctx)
      out.push(...page.members)
      if (page.nextCursor === undefined) return out
      cursor = page.nextCursor
    }
    return out
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new SubmitCandidatesError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
