import type { DefinitionCandidateKind } from './asset-candidates'
import type { NonEmptyString, Uuid, WebSearchFreshnessHint } from './generated/contracts'

/**
 * A bounded research brief an agent researches an industry workspace against. It states the
 * modelling goal, the exact domains the agent may read (the allowlist is never widened) and the
 * candidate kinds it may propose. It is a proposal input, not an approval: every source the agent
 * finds is stored `agent_researched` and every candidate still needs the normal human review.
 *
 * Design §2.1 extends the brief with the standard revisions it targets, the modelling granularity,
 * the naming convention candidates should follow, and a `sourceLimit` distinct from
 * `candidateLimit`. The new fields are optional so a legacy `modeling-brief@1` request stays
 * readable; a research request that separates the two counts is a separate versioned contract.
 */
export interface ModelingBriefMustCover {
  readonly kind: string
  readonly name: string
  readonly note?: string
}

/** A standard the brief targets; `revision` is the exact edition the workspace is modelled on. */
export interface ModelingBriefStandard {
  readonly standardId: NonEmptyString
  readonly revision: NonEmptyString
  readonly title?: NonEmptyString
}

export type ModelingBriefGranularity = 'coarse' | 'standard' | 'fine'
export type ModelingBriefCaseStyle = 'pascal_case' | 'camel_case' | 'snake_case' | 'kebab_case'

export interface ModelingBriefNamingConvention {
  readonly caseStyle?: ModelingBriefCaseStyle
  readonly locale?: NonEmptyString
  /** A bounded regular expression candidate names should match, e.g. `^[A-Z][A-Za-z0-9]*$`. */
  readonly pattern?: NonEmptyString
  readonly note?: NonEmptyString
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
  /** Standard editions the brief targets; bounded and distinct. */
  readonly standardVersions?: readonly ModelingBriefStandard[]
  readonly granularity?: ModelingBriefGranularity
  readonly namingConvention?: ModelingBriefNamingConvention
  /** The maximum number of research *sources* to discover/archive; distinct from candidateLimit. */
  readonly sourceLimit?: number
  /** The maximum number of *candidates* to generate once sources are confirmed. */
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
const GRANULARITIES: readonly ModelingBriefGranularity[] = ['coarse', 'standard', 'fine']
const CASE_STYLES: readonly ModelingBriefCaseStyle[] = ['pascal_case', 'camel_case', 'snake_case', 'kebab_case']
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/iu

function isUuidLike(value: unknown): value is Uuid {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function assertStandardVersions(brief: Record<string, unknown>): void {
  const standards = brief['standardVersions']
  if (standards === undefined) return
  if (!Array.isArray(standards) || standards.length === 0 || standards.length > 16) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief standard list must contain 1..16 entries')
  }
  const ids = new Set<string>()
  for (const standard of standards) {
    if (typeof standard !== 'object' || standard === null || Array.isArray(standard)) {
      throw new ModelingBriefError('INVALID_BRIEF', 'each standard must be an object')
    }
    const entry = standard as Record<string, unknown>
    if (!isNonEmptyString(entry['standardId']) || String(entry['standardId']).length > 256
      || !isNonEmptyString(entry['revision']) || String(entry['revision']).length > 256
      || (entry['title'] !== undefined && (!isNonEmptyString(entry['title']) || String(entry['title']).length > 512))) {
      throw new ModelingBriefError('INVALID_BRIEF', 'each standard needs a standardId and revision, and an optional bounded title')
    }
    if (ids.has(String(entry['standardId']))) throw new ModelingBriefError('INVALID_BRIEF', 'standard versions must be distinct')
    ids.add(String(entry['standardId']))
  }
}

function assertNamingConvention(brief: Record<string, unknown>): void {
  const convention = brief['namingConvention']
  if (convention === undefined) return
  if (typeof convention !== 'object' || convention === null || Array.isArray(convention)) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a naming convention must be an object')
  }
  const entry = convention as Record<string, unknown>
  if (Object.keys(entry).some((key) => !['caseStyle', 'locale', 'pattern', 'note'].includes(key))) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a naming convention has unknown fields')
  }
  if (entry['caseStyle'] !== undefined && !CASE_STYLES.includes(entry['caseStyle'] as ModelingBriefCaseStyle)) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a naming convention case style is not known')
  }
  for (const key of ['locale', 'pattern', 'note'] as const) {
    const field = entry[key]
    if (field !== undefined && (!isNonEmptyString(field) || String(field).length > 512)) {
      throw new ModelingBriefError('INVALID_BRIEF', `a naming convention ${key} must be a bounded non-empty string`)
    }
  }
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
  if (brief['sourceLimit'] !== undefined && (!Number.isSafeInteger(brief['sourceLimit']) || (brief['sourceLimit'] as number) < 1 || (brief['sourceLimit'] as number) > 200)) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief source limit must be within 1..200')
  }
  if (brief['granularity'] !== undefined && !GRANULARITIES.includes(brief['granularity'] as ModelingBriefGranularity)) {
    throw new ModelingBriefError('INVALID_BRIEF', 'a modeling brief granularity is not known')
  }
  assertStandardVersions(brief)
  assertNamingConvention(brief)
}
