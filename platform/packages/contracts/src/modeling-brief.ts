import type { DefinitionCandidateKind } from './asset-candidates'
import type { NonEmptyString, Uuid, WebSearchFreshnessHint } from './generated/contracts'

/**
 * A bounded research brief an agent researches an industry workspace against. It states the
 * modelling goal, the exact domains the agent may read (the allowlist is never widened) and the
 * candidate kinds it may propose. It is a proposal input, not an approval: every source the agent
 * finds is stored `agent_researched` and every candidate still needs the normal human review.
 */
export interface ModelingBriefMustCover {
  readonly kind: string
  readonly name: string
  readonly note?: string
}

export interface ModelingBrief {
  readonly schemaVersion: 'modeling-brief@1'
  readonly workspaceId: Uuid
  /** The modelling goal, e.g. "按 GB50500 建桥架计价本体". */
  readonly goal: NonEmptyString
  /** The exact domains the agent may read; at least one and bounded. */
  readonly allowedResearchDomains: readonly string[]
  readonly freshnessHint?: WebSearchFreshnessHint
  /** The candidate kinds the agent may propose; bounded and non-empty. */
  readonly targetKinds: readonly DefinitionCandidateKind[]
  readonly mustCover?: readonly ModelingBriefMustCover[]
  readonly candidateLimit?: number
}

export class ModelingBriefError extends Error {
  constructor(readonly code: 'INVALID_BRIEF', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelingBriefError'
  }
}

const DEFINITION_KINDS: readonly DefinitionCandidateKind[] = ['object', 'attribute', 'relation']
const FRESHNESS_HINTS: readonly WebSearchFreshnessHint[] = ['any', 'day', 'week', 'month', 'year']
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/iu

function isUuidLike(value: unknown): value is Uuid {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}

/** Runtime validation of a brief before any provider request is made. */
export function assertModelingBriefShape(value: unknown): asserts value is ModelingBrief {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief must be an object')
  const brief = value as Record<string, unknown>
  const domains = brief['allowedResearchDomains']
  if (brief['schemaVersion'] !== 'modeling-brief@1' || !isUuidLike(brief['workspaceId'])
    || typeof brief['goal'] !== 'string' || brief['goal'].trim().length === 0 || brief['goal'].length > 2000
    || !Array.isArray(domains) || domains.length === 0 || domains.length > 32
    || domains.some((domain) => typeof domain !== 'string' || !DOMAIN.test(domain))
    || (brief['freshnessHint'] !== undefined && !FRESHNESS_HINTS.includes(brief['freshnessHint'] as WebSearchFreshnessHint))) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief requires a goal, 1..32 valid research domains and a known freshness hint')
  }
  const kinds = brief['targetKinds']
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => !DEFINITION_KINDS.includes(kind as DefinitionCandidateKind))
    || new Set(kinds).size !== kinds.length) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief requires distinct, known target candidate kinds')
  }
  if (brief['candidateLimit'] !== undefined && (!Number.isSafeInteger(brief['candidateLimit']) || (brief['candidateLimit'] as number) < 1 || (brief['candidateLimit'] as number) > 500)) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief candidate limit must be within 1..500')
  }
}
