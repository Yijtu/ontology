import { assertModelingBriefShape, CandidateSourceError } from '@ontology/contracts'
import type {
  CandidateSource,
  ModelingBrief,
  Rfc3339UtcTimestamp,
  ToolContext,
  WebSearchProvider,
  WebSearchProviderResult,
} from '@ontology/contracts'
import type { CandidateSourceIngestionService } from './ingestion-service'

const RESEARCH_ROLES: readonly string[] = ['researcher', 'platform-admin']
const DEFAULT_PAGE_LIMIT = 10
const MAX_PAGE_LIMIT = 25

export type WebResearchErrorCode = 'FORBIDDEN' | 'INVALID_REQUEST' | 'RESEARCH_FAILED'

export class WebResearchError extends Error {
  constructor(readonly code: WebResearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebResearchError'
  }
}

export interface WebResearchInput {
  readonly brief: ModelingBrief
  /** When this workspace started the research; the freshness clock for every ingested snapshot. */
  readonly retrievedAt: Rfc3339UtcTimestamp
  /** The propagated deadline the provider must respect. */
  readonly deadline: Rfc3339UtcTimestamp
  /** The run's cancellation signal; a bounded research call honours it. */
  readonly signal?: AbortSignal
  /** The research call's idempotency key; per-page keys are derived from it. */
  readonly idempotencyKey: string
}

export interface WebResearchDependencies {
  /** The replaceable public-web reader. The research flow never widens the brief's allowlist. */
  readonly webSearch: WebSearchProvider
  readonly ingestion: CandidateSourceIngestionService
  readonly now?: () => string
}

export interface WebResearchResult {
  readonly brief: ModelingBrief
  /** The proposed `agent_researched` sources a human may review, promote or reject. */
  readonly sources: readonly CandidateSource[]
  /** Pages the provider returned without an archived snapshot; they are reported, never faked. */
  readonly skippedWithoutSnapshot: number
}

/**
 * The modelling research flow: one `ModelingBrief` becomes a set of proposed candidate sources.
 *
 * It is deliberately workspace-scoped (the brief names an industry workspace, never a customer
 * project), so research never reaches a project's data boundary. The agent may read only the
 * domains the brief approved and may only *propose* sources: every snapshot is stored
 * `agent_researched` + `proposed`, so the existing review gate still decides what may be published.
 */
export class WebResearchService {
  constructor(readonly dependencies: WebResearchDependencies) {}

  async research(input: WebResearchInput, ctx: ToolContext): Promise<WebResearchResult> {
    if (!ctx.principal.roles.some((role) => RESEARCH_ROLES.includes(role))) {
      throw new WebResearchError('FORBIDDEN', 'web research requires a researcher or platform-admin role')
    }
    assertModelingBriefShape(input.brief)
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new WebResearchError('INVALID_REQUEST', 'research requires an idempotency key of 8..200 characters')
    }
    if (typeof input.retrievedAt !== 'string' || !Number.isFinite(Date.parse(input.retrievedAt))) {
      throw new WebResearchError('INVALID_REQUEST', 'research requires a valid retrieval instant')
    }
    if (typeof input.deadline !== 'string' || !Number.isFinite(Date.parse(input.deadline))) {
      throw new WebResearchError('INVALID_REQUEST', 'research requires a valid deadline')
    }
    const limit = Math.min(input.brief.candidateLimit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
    const result = await this.#search(input.brief, limit, input.deadline, input.signal ?? new AbortController().signal, ctx)

    const sources: CandidateSource[] = []
    let skippedWithoutSnapshot = 0
    for (const page of result.pages) {
      if (page.snapshotRef === undefined) { skippedWithoutSnapshot += 1; continue }
      try {
        sources.push(await this.dependencies.ingestion.ingestArchivedWebSnapshot({
          workspaceId: input.brief.workspaceId,
          url: page.url,
          title: page.title,
          fetchedAt: page.fetchedAt,
          retrievedAt: input.retrievedAt,
          contentRef: page.snapshotRef,
          contentDigest: page.contentDigest,
          idempotencyKey: `${input.idempotencyKey}:${page.url}`,
        }, ctx))
      } catch (error) {
        if (error instanceof CandidateSourceError && error.code === 'INVALID_SOURCE') { skippedWithoutSnapshot += 1; continue }
        throw error
      }
    }
    return { brief: input.brief, sources, skippedWithoutSnapshot }
  }

  async #search(brief: ModelingBrief, limit: number, deadline: Rfc3339UtcTimestamp, signal: AbortSignal, ctx: ToolContext): Promise<WebSearchProviderResult> {
    try {
      return await this.dependencies.webSearch.search({
        query: brief.goal,
        allowedDomains: brief.allowedResearchDomains,
        ...(brief.freshnessHint === undefined ? {} : { freshnessHint: brief.freshnessHint }),
        limit,
        deadline,
        signal,
      }, ctx)
    } catch (error) {
      throw new WebResearchError('RESEARCH_FAILED', 'the web search provider failed', { cause: error })
    }
  }
}
