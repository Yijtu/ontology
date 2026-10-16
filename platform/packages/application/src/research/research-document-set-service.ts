import {
  ResearchDocumentSetError,
  assertResearchDocumentMemberShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  DocumentTargetedSelection,
  ResearchArchiveParsePort,
  ResearchDocumentMember,
  ResearchDocumentMemberPage,
  ResearchDocumentSet,
  ResearchDocumentSetStore,
  ScopeRef,
  Semver,
  Sha256Digest,
  ToolContext,
  Uuid,
  WebSearchToolPage,
  WebSnapshotSkipReason,
} from '@ontology/contracts'

/** One link-only discovery that could not be staged, kept with the exact reason (design §6). */
export interface StageSkippedDiscovery {
  readonly url: string
  readonly reason: WebSnapshotSkipReason
}

export interface StageArchivedDiscoveryInput {
  readonly workspaceId: Uuid
  readonly runId: Uuid
  /** The `web_search` discovery union; only `archived` pages become members. */
  readonly pages: readonly WebSearchToolPage[]
}

export interface StageArchivedDiscoveryReceipt {
  /** The members this call staged, or the existing member on a replay. */
  readonly staged: readonly ResearchDocumentMember[]
  /** Every discovery-only page, so "found a link" is never silently dropped as "staged". */
  readonly skipped: readonly StageSkippedDiscovery[]
}

/** An already-authorized document (uploaded/authorized) to compose into the same evidence set. */
export interface StageAuthorizedDocumentInput {
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly documentRef: ResearchDocumentMember['documentRef']
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly parseRef: ResearchDocumentMember['parseRef']
  readonly normalizedRef?: ResearchDocumentMember['normalizedRef']
  readonly contentDigest: Sha256Digest
  readonly fetchedAt?: ResearchDocumentMember['fetchedAt']
}

export interface ResearchDocumentSetServiceDependencies {
  readonly members: ResearchDocumentSetStore
  /**
   * Parses an archived page's original bytes into a readable binding, reusing the existing document
   * parser/span facilities. The implementation lives in an adapter; staging never re-implements
   * parsing.
   */
  readonly parser: ResearchArchiveParsePort
  readonly newId?: () => string
  readonly now?: () => string
}

/** The per-run member bound used to page one evidence set. */
export interface ListMembersInput {
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly limit: number
  readonly cursor?: string
}

/** The immutable identity of a staged member, before ids/timestamps are minted. */
interface StagedMemberInput {
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly kind: ResearchDocumentMember['kind']
  readonly documentRef: ResearchDocumentMember['documentRef']
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly parseRef: ResearchDocumentMember['parseRef']
  readonly normalizedRef?: ResearchDocumentMember['normalizedRef']
  readonly provenanceRef?: ResearchDocumentMember['provenanceRef']
  readonly contentDigest: Sha256Digest
  readonly fetchedAt?: ResearchDocumentMember['fetchedAt']
  readonly sourceUrl?: string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Builds and reads the research **staging** document set (design §4/§6).
 *
 * An archived `web_search` page is parsed through the existing parser, and the resulting readable
 * document is recorded as a `research_archive` member; an uploaded/authorized document can be
 * staged into the same run as an `authorized_document` member, so one evidence set composes both.
 * Only `archived` discoveries are staged: a `discovery_only` link is recorded with its reason and
 * can never be a member. Every member is `staged: true, inGroundingCorpus: false`, so this service
 * has no path that writes an approved `GroundingDocumentSet` or a project corpus.
 */
export class ResearchDocumentSetService {
  readonly #dependencies: ResearchDocumentSetServiceDependencies
  readonly #newId: () => string
  readonly #now: () => string

  constructor(dependencies: ResearchDocumentSetServiceDependencies) {
    this.#dependencies = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async stageArchivedDiscoveries(
    input: StageArchivedDiscoveryInput,
    ctx: ToolContext,
  ): Promise<StageArchivedDiscoveryReceipt> {
    const scope = scopeOf(ctx)
    const staged: ResearchDocumentMember[] = []
    const skipped: StageSkippedDiscovery[] = []
    for (const page of input.pages) {
      if (page.discovery === 'discovery_only') {
        // A link is honest data, never a citable original: record the reason instead of staging it.
        skipped.push({ url: page.url, reason: page.unavailableReason })
        continue
      }
      const binding = await this.#dependencies.parser.parseArchivedPage(
        {
          // Parse the readable form the archiver actually produced. An HTML page is archived as
          // original bytes plus a separately-derived `text/plain` view; the document parser only
          // understands text/pdf, so the derived readable ref is parsed when present and the raw
          // snapshot only when it is the readable form (design §6: 归档页面必须能读).
          documentRef: page.parsedRef ?? page.snapshotRef,
          provenanceRef: page.snapshotManifestRef,
          ...(page.contentForm === undefined ? {} : { contentForm: page.contentForm }),
        },
        ctx,
      )
      staged.push(
        await this.#stage(scope, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          kind: 'research_archive',
          documentRef: binding.documentRef,
          parseId: binding.parseId,
          parserVersion: binding.parserVersion,
          parseRef: binding.parseRef,
          ...(binding.normalizedRef === undefined ? {} : { normalizedRef: binding.normalizedRef }),
          provenanceRef: page.snapshotManifestRef,
          contentDigest: page.contentDigest,
          fetchedAt: page.fetchedAt,
          sourceUrl: page.url,
        }, ctx),
      )
    }
    return { staged, skipped }
  }

  /** Compose an uploaded/authorized document into the same run's evidence set (design §4). */
  async stageAuthorizedDocument(
    input: StageAuthorizedDocumentInput,
    ctx: ToolContext,
  ): Promise<ResearchDocumentMember> {
    const scope = scopeOf(ctx)
    return this.#stage(scope, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      kind: 'authorized_document',
      documentRef: input.documentRef,
      parseId: input.parseId,
      parserVersion: input.parserVersion,
      parseRef: input.parseRef,
      ...(input.normalizedRef === undefined ? {} : { normalizedRef: input.normalizedRef }),
      contentDigest: input.contentDigest,
      ...(input.fetchedAt === undefined ? {} : { fetchedAt: input.fetchedAt }),
    }, ctx)
  }

  async listMembers(input: ListMembersInput, ctx: ToolContext): Promise<ResearchDocumentMemberPage> {
    const scope = scopeOf(ctx)
    return this.#dependencies.members.listMembers(scope, input, ctx)
  }

  /** Assemble one run's staged set. Bounded: a set larger than `limit` is explicitly truncated. */
  async readSet(input: ListMembersInput, ctx: ToolContext): Promise<ResearchDocumentSet> {
    const page = await this.listMembers(input, ctx)
    return {
      schemaVersion: 'research-document-set@1',
      workspaceId: input.workspaceId,
      runId: input.runId,
      members: page.members,
      recordedAt: this.#now(),
    }
  }

  /**
   * Project staged members into bounded targeted-read selections, so the agent continues reading
   * the exact archived/authorized documents (and their parses) it staged instead of re-searching.
   */
  toTargetedSelections(members: readonly ResearchDocumentMember[]): readonly DocumentTargetedSelection[] {
    return members.map((member) => ({ documentRef: member.documentRef, parseId: member.parseId }))
  }

  async #stage(scope: ScopeRef, input: StagedMemberInput, ctx: ToolContext): Promise<ResearchDocumentMember> {
    const member: ResearchDocumentMember = {
      schemaVersion: 'research-document-member@1',
      memberId: this.#newId(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      kind: input.kind,
      documentRef: input.documentRef,
      parseId: input.parseId,
      parserVersion: input.parserVersion,
      parseRef: input.parseRef,
      ...(input.normalizedRef === undefined ? {} : { normalizedRef: input.normalizedRef }),
      ...(input.provenanceRef === undefined ? {} : { provenanceRef: input.provenanceRef }),
      contentDigest: input.contentDigest,
      ...(input.fetchedAt === undefined ? {} : { fetchedAt: input.fetchedAt }),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
      staged: true,
      inGroundingCorpus: false,
      recordedAt: this.#now(),
    }
    assertResearchDocumentMemberShape(member)
    const result = await this.#dependencies.members.appendMember(scope, member, ctx)
    return result.member
  }
}
