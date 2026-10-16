import { ResearchError, assertResearchRequestShape, isRecord, isResourceRef, isUuid } from '@ontology/contracts'
import type { ResearchRequest, ResourceRef, Uuid } from '@ontology/contracts'
import { canonicalJson } from '../../extraction/canonical'

export const RESEARCH_JOB_REQUEST_KIND = 'workbench.research-job'

/**
 * The legacy research job version. A `@1` job carries the exact authorized `ResearchRequest` in its
 * opaque `datasetRef` and is executed by the fixed legacy chain.
 */
export const RESEARCH_JOB_VERSION_LEGACY = '1.0.0'

/**
 * The catalogue research job version (S03). It carries the same authorized `ResearchRequest` as the
 * legacy payload, but it is executed by the fixed chain that resolves its public search from the
 * pinned tool-connection catalogue (`web_search` at the run's workspace scope) rather than from the
 * deployment environment. It is deliberately a distinct version so a durable job written before
 * migration keeps its legacy environment execution path and is never silently re-pointed.
 */
export const RESEARCH_JOB_VERSION_CATALOGUE = '1.1.0'

/**
 * The agentic research job version. A `@2` job carries only the run identity — the research id, the
 * controller run id and the archived run manifest reference — never a re-encodable request, so a
 * durable job cannot be retargeted by editing defaults.
 */
export const RESEARCH_JOB_VERSION_AGENT = '2.0.0'

export const RESEARCH_JOB_VERSIONS: readonly string[] = [
  RESEARCH_JOB_VERSION_LEGACY, RESEARCH_JOB_VERSION_CATALOGUE, RESEARCH_JOB_VERSION_AGENT,
]

/**
 * The bounded legacy research payload encoded into the durable job's opaque `datasetRef`.
 *
 * A research job carries no secrets and no provider body: it names the run and pins the exact
 * `ResearchRequest` (brief, limits, allowlist, policy/budget refs) that was authorized. The worker
 * decodes it and runs precisely that request, so a later change of defaults cannot retarget the
 * job; the research-execution record then references the same brief/policy/budget.
 */
export interface ResearchJobRequestLegacy {
  readonly kind: typeof RESEARCH_JOB_REQUEST_KIND
  readonly version: typeof RESEARCH_JOB_VERSION_LEGACY
  readonly researchId: Uuid
  readonly request: ResearchRequest
}

/**
 * The catalogue research payload (S03). Shape-identical to the legacy payload (the same authorized
 * request), but the worker resolves the public search from the pinned catalogue binding. The version
 * discriminator is the only difference, so a legacy job is never re-pointed by a reader.
 */
export interface ResearchJobRequestCatalogue {
  readonly kind: typeof RESEARCH_JOB_REQUEST_KIND
  readonly version: typeof RESEARCH_JOB_VERSION_CATALOGUE
  readonly researchId: Uuid
  readonly request: ResearchRequest
}

/**
 * The agentic research job payload (design §4/§8): it names the run the controller owns and the
 * archived manifest that pins the runtime, model/tool bindings, authorization receipt and ledger.
 * It carries no request body, so the agent run is re-armed from its manifest, not from a mutable
 * payload.
 */
export interface ResearchJobRequestAgent {
  readonly kind: typeof RESEARCH_JOB_REQUEST_KIND
  readonly version: typeof RESEARCH_JOB_VERSION_AGENT
  readonly researchId: Uuid
  readonly runId: Uuid
  readonly manifestRef: ResourceRef
}

/** Either supported research job payload, discriminated by `version`. */
export type ResearchJobRequest =
  | ResearchJobRequestLegacy
  | ResearchJobRequestCatalogue
  | ResearchJobRequestAgent

export function encodeResearchJobRequest(request: ResearchJobRequest): string {
  return canonicalJson(request)
}

export function isLegacyResearchJobRequest(ref: ResearchJobRequest): ref is ResearchJobRequestLegacy {
  return ref.version === RESEARCH_JOB_VERSION_LEGACY
}

/** A catalogue job carries the request but resolves its search from the pinned catalogue binding. */
export function isCatalogueResearchJobRequest(ref: ResearchJobRequest): ref is ResearchJobRequestCatalogue {
  return ref.version === RESEARCH_JOB_VERSION_CATALOGUE
}

export function isAgentResearchJobRequest(ref: ResearchJobRequest): ref is ResearchJobRequestAgent {
  return ref.version === RESEARCH_JOB_VERSION_AGENT
}

export function isResearchJobRef(datasetRef: string | undefined): boolean {
  if (datasetRef === undefined) return false
  try {
    decodeResearchJobRequest(datasetRef)
    return true
  } catch {
    return false
  }
}

/**
 * Decode and runtime-validate a durable research job reference into its version union.
 *
 * The `version` is the discriminator, not a free string: an explicit unknown version is refused
 * rather than being executed as a legacy request. A legacy payload still validates the full
 * `ResearchRequest`; an agent payload validates the run id and the manifest reference. A missing
 * version is read as legacy `1.0.0` for the jobs written before the field existed.
 */
export function decodeResearchJobRequest(datasetRef: string | undefined): ResearchJobRequest {
  if (datasetRef === undefined) {
    throw new ResearchError('INVALID_REQUEST', 'a research job requires an encoded dataset reference')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(datasetRef)
  } catch (error) {
    throw new ResearchError('INVALID_REQUEST', 'the research job reference is not valid JSON', { cause: error })
  }
  if (!isRecord(parsed) || parsed['kind'] !== RESEARCH_JOB_REQUEST_KIND || !isUuid(parsed['researchId'])) {
    throw new ResearchError(
      'INVALID_REQUEST',
      `the research job reference must declare kind=${RESEARCH_JOB_REQUEST_KIND} and a researchId`,
    )
  }
  const researchId = parsed['researchId']
  const version = parsed['version'] === undefined ? RESEARCH_JOB_VERSION_LEGACY : parsed['version']
  if (version === RESEARCH_JOB_VERSION_LEGACY) {
    assertResearchRequestShape(parsed['request'])
    return { kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_LEGACY, researchId, request: parsed['request'] }
  }
  if (version === RESEARCH_JOB_VERSION_CATALOGUE) {
    assertResearchRequestShape(parsed['request'])
    return { kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_CATALOGUE, researchId, request: parsed['request'] }
  }
  if (version === RESEARCH_JOB_VERSION_AGENT) {
    if (!isUuid(parsed['runId']) || !isResourceRef(parsed['manifestRef'])) {
      throw new ResearchError('INVALID_REQUEST', 'an agent research job reference requires a runId and a manifest reference')
    }
    return {
      kind: RESEARCH_JOB_REQUEST_KIND,
      version: RESEARCH_JOB_VERSION_AGENT,
      researchId,
      runId: parsed['runId'],
      manifestRef: parsed['manifestRef'],
    }
  }
  throw new ResearchError('INVALID_REQUEST', `unknown research job version ${String(version)}`)
}
