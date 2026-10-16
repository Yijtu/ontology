import { assertModelingBriefShape, CandidateSourceError } from '@ontology/contracts'
import type {
  CandidateSource,
  ModelingBrief,
  ResourceRef,
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
  /**
   * A per-page admission gate. The run checks it before ingesting each page, so a run that was
   * cancelled (or whose fence was retracted) admits no further snapshots even after the provider
   * returned. A `false` result stops the run without an error; the pages already ingested stay
   * readable and the remaining ones are simply never registered.
   */
  readonly admit?: () => Promise<boolean>
  /**
   * Reserves the run's source budget for one page **before** it is ingested, on the run's one
   * shared ledger and original deadline. A `false` result stops pagination (the source ceiling was
   * reached); it is an idempotent reservation keyed by the page URL, so a re-page of the same URL
   * neither double-charges nor bypasses the ceiling.
   */
  readonly reserveSource?: (url: string) => Promise<boolean>
  /**
   * Settles a reserved source against the exact archived content it produced. Called once per
   * successfully ingested page so the reservation closes with the real evidence ref instead of
   * staying open until the ledger deadline.
   */
  readonly recordSource?: (url: string, contentRef: ResourceRef) => Promise<void>
}

export interface WebResearchDependencies {
  /** The replaceable public-web reader. The research flow never widens the brief's allowlist. */
  readonly webSearch: WebSearchProvider
  readonly ingestion: CandidateSourceIngestionService
  readonly now?: () => string
}

/**
 * Honest coverage statistics for one bounded research call. Every discovered, skipped, excluded,
 * truncated or failed page is reported; the caller never has to re-derive them from a page list.
 */
export interface WebResearchCoverage {
  readonly searchCalls: number
  readonly pagesDiscovered: number
  readonly archivedSnapshots: number
  /** Pages seen without an archived snapshot: links only, never citable as a formal basis. */
  readonly skippedWithoutSnapshot: number
  /** Pages the provider dropped because their host was outside the approved allowlist. */
  readonly excludedCount: number
  /** Pages whose snapshot could not be registered as a candidate source. */
  readonly failedCount: number
  readonly truncated: boolean
}

export interface WebResearchResult {
  readonly brief: ModelingBrief
  /** The proposed `agent_researched` sources a human may review, promote or reject. */
  readonly sources: readonly CandidateSource[]
  /** Pages the provider returned without an archived snapshot; they are reported, never faked. */
  readonly skippedWithoutSnapshot: number
  readonly coverage: WebResearchCoverage
}

/**
 * The modelling research flow: one `ModelingBrief` becomes a set of proposed candidate sources.
 *
 * It is deliberately workspace-scoped (the brief names an industry workspace, never a customer
 * project), so research never reaches a project's data boundary. The agent may read only the
 * domains the brief approved and may only *propose* sources: every snapshot is stored
 * `agent_researched` + `proposed`, so the existing review gate still decides what may be published.
 *
 * The request may carry an `admit` gate and a `signal`. Both are checked before each page is
 * registered, so a cancelled run or a retracted fence never admits a page the provider fetched
 * after the stop, and the coverage reports exactly what was and was not registered.
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
    const limit = Math.min(input.brief.sourceLimit ?? input.brief.candidateLimit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
    const signal = input.signal ?? new AbortController().signal
    const result = await this.#search(input.brief, limit, input.deadline, signal, ctx)

    const sources: CandidateSource[] = []
    let skippedWithoutSnapshot = 0
    let failedCount = 0
    for (const page of result.pages) {
      if (signal.aborted) break
      if (input.admit !== undefined && !(await input.admit())) break
      if (page.snapshotRef === undefined) {
        skippedWithoutSnapshot += 1
        continue
      }
      // Reserve the source budget on the run's one ledger before ingesting: a page beyond the
      // source ceiling is never registered, and a concurrent/re-paged run cannot oversubscribe.
      if (input.reserveSource !== undefined && !(await input.reserveSource(page.url))) break
      try {
        const source = await this.dependencies.ingestion.ingestArchivedWebSnapshot({
          workspaceId: input.brief.workspaceId,
          url: page.url,
          title: page.title,
          fetchedAt: page.fetchedAt,
          retrievedAt: input.retrievedAt,
          contentRef: page.snapshotRef,
          contentDigest: page.contentDigest,
          idempotencyKey: `${input.idempotencyKey}:${page.url}`,
        }, ctx)
        if (input.recordSource !== undefined) await input.recordSource(page.url, source.contentRef)
        sources.push(source)
      } catch (error) {
        if (!(error instanceof CandidateSourceError)) throw error
        // A systemic scope/store failure must not be swallowed into a count; only a page-level
        // failure is reported as a failed page and the bounded run continues.
        if (error.code === 'STORE_FAILED' || error.code === 'SCOPE_MISMATCH' || error.code === 'FORBIDDEN') throw error
        if (error.code === 'INVALID_SOURCE') skippedWithoutSnapshot += 1
        else failedCount += 1
      }
    }
    return {
      brief: input.brief,
      sources,
      skippedWithoutSnapshot,
      coverage: {
        searchCalls: 1,
        pagesDiscovered: result.pages.length,
        archivedSnapshots: sources.length,
        skippedWithoutSnapshot,
        excludedCount: result.excludedCount,
        failedCount,
        truncated: result.truncated,
      },
    }
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
