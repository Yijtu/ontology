import type {
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import { isRecord, isResourceRef, isSha256Digest, isUuid } from './asset-workspace'
import type { ToolContext } from './trusted'

/**
 * The research **staging** document set (design §4/§6).
 *
 * Archiving a public page or pointing at an uploaded/authorized document during a research run
 * produces a *staged* member, not a modelling corpus entry. A staged member is bound to
 * `tenant/space/workspace/run`, is readable through the existing parse/span-reader/index
 * facilities, and can be composed with members from other origins into one evidence set — but it
 * is explicitly **not** part of an approved `GroundingDocumentSet` and never enters a project
 * corpus. `staged` and `inGroundingCorpus` are literal guards so a new write path cannot silently
 * promote research material to formal grounding.
 *
 * `kind` distinguishes the two composable origins: a `research_archive` is a page this run archived
 * (its `provenanceRef` is the web snapshot manifest), while an `authorized_document` is a document
 * the operator already uploaded/authorized (its `documentRef` is the existing readable document).
 * One research evidence set may carry both, so a single candidate can cite a snapshot and an
 * uploaded document together (design §4).
 */
export type ResearchDocumentMemberKind = 'research_archive' | 'authorized_document'

/** One staged README-able document a research run may read; never a formal grounding source. */
export interface ResearchDocumentMember {
  readonly schemaVersion: 'research-document-member@1'
  readonly memberId: Uuid
  readonly workspaceId: Uuid
  /** The run whose evidence set owns this member; a member never leaks to another run. */
  readonly runId: Uuid
  readonly kind: ResearchDocumentMemberKind
  /** The readable logical document (the archived original bytes, or the authorized document). */
  readonly documentRef: ResourceRef
  readonly parseId: Uuid
  readonly parserVersion: Semver
  /** The exact parse artifact this member reads through, bound to `parserVersion`. */
  readonly parseRef: ResourceRef
  /** The separately archived normalized text, when the archiver produced one. */
  readonly normalizedRef?: ResourceRef
  /** The provenance record (the web snapshot manifest) for a research archive. */
  readonly provenanceRef?: ResourceRef
  /** The digest of the readable content the member resolves to. */
  readonly contentDigest: Sha256Digest
  readonly fetchedAt?: Rfc3339UtcTimestamp
  /** The origin page address for a research archive; absent for an uploaded document. */
  readonly sourceUrl?: string
  /** Literal: this member is research-staged material, not an approved corpus entry. */
  readonly staged: true
  /** Literal: this member is NOT part of a `GroundingDocumentSet` and never enters a corpus. */
  readonly inGroundingCorpus: false
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** The staged evidence set of one research run, composed of members from any origin. */
export interface ResearchDocumentSet {
  readonly schemaVersion: 'research-document-set@1'
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly members: readonly ResearchDocumentMember[]
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ResearchDocumentMemberPage {
  readonly members: readonly ResearchDocumentMember[]
  readonly nextCursor?: string
}

/**
 * The readable binding produced from an archived page's bytes (design §6). The staging service
 * parses a `research_archive`'s original snapshot *through the existing parser/span facilities* and
 * records the resulting document/parse so the agent can read real fragments; `documentRef` is the
 * readable original, `parseRef` the span map, and `normalizedRef` the derived normalized text.
 */
export interface ResearchArchivedDocumentBinding {
  readonly documentRef: ResourceRef
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly parseRef: ResourceRef
  readonly normalizedRef?: ResourceRef
}

/** Parses an archived page's original bytes into a readable, span-locatable document binding. */
export interface ResearchArchiveParsePort {
  parseArchivedPage(input: {
    readonly documentRef: ResourceRef
    readonly provenanceRef: ResourceRef
    readonly contentForm?: string
  }, ctx: ToolContext): Promise<ResearchArchivedDocumentBinding>
}

/**
 * Control persistence for staged research members. Every key carries tenant/space (RLS) and the
 * `(workspace, run)` binding is re-checked on every read, so a member is only visible to the run
 * that staged it. The store has no method that writes an approved document set: staging can never
 * become a corpus write.
 */
export interface ResearchDocumentSetStore {
  appendMember(
    scopeRef: ScopeRef,
    member: ResearchDocumentMember,
    ctx: ToolContext,
  ): Promise<{ readonly member: ResearchDocumentMember; readonly created: boolean }>
  getMember(scopeRef: ScopeRef, memberId: Uuid, ctx: ToolContext): Promise<ResearchDocumentMember | undefined>
  /** The members staged for one run, bounded and paged so a set can never be read whole. */
  listMembers(
    scopeRef: ScopeRef,
    input: { readonly workspaceId: Uuid; readonly runId: Uuid; readonly limit: number; readonly cursor?: string },
    ctx: ToolContext,
  ): Promise<ResearchDocumentMemberPage>
}

export type ResearchDocumentSetErrorCode =
  | 'INVALID_REQUEST'
  | 'SCOPE_MISMATCH'
  | 'NOT_FOUND'
  | 'NOT_ARCHIVED'
  | 'STORE_FAILED'

export class ResearchDocumentSetError extends Error {
  constructor(readonly code: ResearchDocumentSetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchDocumentSetError'
  }
}

export const RESEARCH_DOCUMENT_MEMBER_KINDS: readonly ResearchDocumentMemberKind[] = [
  'research_archive',
  'authorized_document',
]

function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.length > 0
}

/** Runtime validation of a staged research member before it is persisted. */
export function assertResearchDocumentMemberShape(
  value: unknown,
): asserts value is ResearchDocumentMember {
  if (!isRecord(value) || value['schemaVersion'] !== 'research-document-member@1'
    || !isUuid(value['memberId']) || !isUuid(value['workspaceId']) || !isUuid(value['runId'])
    || !RESEARCH_DOCUMENT_MEMBER_KINDS.includes(value['kind'] as ResearchDocumentMemberKind)
    || !isResourceRef(value['documentRef']) || !isUuid(value['parseId'])
    || !isNonEmptyString(value['parserVersion']) || !isResourceRef(value['parseRef'])
    || (value['normalizedRef'] !== undefined && !isResourceRef(value['normalizedRef']))
    || (value['provenanceRef'] !== undefined && !isResourceRef(value['provenanceRef']))
    || !isSha256Digest(value['contentDigest'])
    || (value['fetchedAt'] !== undefined && !isNonEmptyString(value['fetchedAt']))
    || (value['sourceUrl'] !== undefined && !isNonEmptyString(value['sourceUrl']))
    || value['staged'] !== true || value['inGroundingCorpus'] !== false
    || !isNonEmptyString(value['recordedAt'])) {
    throw new ResearchDocumentSetError('INVALID_REQUEST', 'invalid research document member')
  }
}

/** Runtime validation of a persisted staged research set. */
export function assertResearchDocumentSetShape(value: unknown): asserts value is ResearchDocumentSet {
  if (!isRecord(value) || value['schemaVersion'] !== 'research-document-set@1'
    || !isUuid(value['workspaceId']) || !isUuid(value['runId'])
    || !Array.isArray(value['members']) || !isNonEmptyString(value['recordedAt'])) {
    throw new ResearchDocumentSetError('INVALID_REQUEST', 'invalid research document set')
  }
  for (const member of value['members']) {
    assertResearchDocumentMemberShape(member)
    if ((member as ResearchDocumentMember).workspaceId !== value['workspaceId']
      || (member as ResearchDocumentMember).runId !== value['runId']) {
      throw new ResearchDocumentSetError('INVALID_REQUEST', 'a member does not belong to its set binding')
    }
  }
}
