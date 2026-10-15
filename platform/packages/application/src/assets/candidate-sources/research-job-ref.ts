import { ResearchError, assertResearchRequestShape } from '@ontology/contracts'
import type { ResearchRequest, Uuid } from '@ontology/contracts'
import { canonicalJson } from '../../extraction/canonical'

export const RESEARCH_JOB_REQUEST_KIND = 'workbench.research-job'

/**
 * The bounded research payload encoded into the durable job's opaque `datasetRef`.
 *
 * A research job carries no secrets and no provider body: it names the run and pins the exact
 * `ResearchRequest` (brief, limits, allowlist, policy/budget refs) that was authorized. The worker
 * decodes it and runs precisely that request, so a later change of defaults cannot retarget the
 * job; the research-execution record then references the same brief/policy/budget.
 */
export interface ResearchJobRequest {
  readonly kind: typeof RESEARCH_JOB_REQUEST_KIND
  readonly version: string
  readonly researchId: Uuid
  readonly request: ResearchRequest
}

export function encodeResearchJobRequest(request: ResearchJobRequest): string {
  return canonicalJson(request)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (!isRecord(parsed) || parsed['kind'] !== RESEARCH_JOB_REQUEST_KIND
    || typeof parsed['researchId'] !== 'string') {
    throw new ResearchError(
      'INVALID_REQUEST',
      `the research job reference must declare kind=${RESEARCH_JOB_REQUEST_KIND} and a researchId`,
    )
  }
  assertResearchRequestShape(parsed['request'])
  return {
    kind: RESEARCH_JOB_REQUEST_KIND,
    version: typeof parsed['version'] === 'string' ? parsed['version'] : '1.0.0',
    researchId: parsed['researchId'],
    request: parsed['request'],
  }
}
