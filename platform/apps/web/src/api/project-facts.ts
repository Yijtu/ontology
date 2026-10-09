import type { ProjectRecordVersion } from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { ApiError } from './errors'
import { isVersionRef } from './projects'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
export interface StagedProjectCandidate {
  readonly candidateId: string
  readonly jobId: string
  readonly objectId: string
  readonly documentId: string
}
/** Submit selectors for stored rows. Source, schema, identity and approval pins stay on the host. */
export async function stageProjectFacts(
  client: WorkbenchClient,
  projectId: string,
  documentId: string,
  rows: readonly ProjectRecordVersion[],
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<readonly StagedProjectCandidate[]> {
  if (
    rows.length === 0 ||
    rows.length > 200 ||
    rows.some((row) => row.projectId !== projectId || row.status !== 'confirmed')
  )
    throw new Error('请选择 1–200 条当前项目已映射确认的记录。')
  const path = `/api/v1/core/projects/${encodeURIComponent(projectId)}/fact-candidates`
  const value = await client.requestJson<unknown>('POST', path, {
    body: { documentId, recordRefs: rows.map((row) => ({ recordId: row.recordId, revision: row.revision })) },
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  const invalid = () =>
    new ApiError(502, {
      code: 'MALFORMED_RESPONSE',
      message: '候选响应与所选原始记录不一致，已停止推进审核。',
      retryable: false,
      reasons: [],
      missingCapabilities: [],
    })
  if (!record(value) || !Array.isArray(value['candidates']) || value['candidates'].length !== rows.length)
    throw invalid()
  const result: StagedProjectCandidate[] = []
  const covered = new Set<string>()
  for (const candidate of value['candidates']) {
    if (
      !record(candidate) ||
      candidate['kind'] !== 'entity' ||
      !uuid(candidate['candidateId']) ||
      !uuid(candidate['jobId']) ||
      typeof candidate['objectId'] !== 'string' ||
      !Array.isArray(candidate['attributes']) ||
      !Array.isArray(candidate['sourceSpans']) ||
      candidate['sourceSpans'].length === 0 ||
      !record(candidate['inputVersion']) ||
      !isVersionRef(candidate['inputVersion']['definitionRef']) ||
      !record(candidate['inputVersion']['projectFact']) ||
      !Array.isArray(candidate['inputVersion']['projectFact']['sources']) ||
      candidate['inputVersion']['projectFact']['sources'].length !== 1
    )
      throw invalid()
    const source: unknown = candidate['inputVersion']['projectFact']['sources'][0]
    if (
      !record(source) ||
      source['documentId'] !== documentId ||
      !record(source['projectRevisionRef']) ||
      source['projectRevisionRef']['projectId'] !== projectId
    )
      throw invalid()
    const row = rows.find(
      (entry) => entry.recordId === source['recordId'] && entry.revision === source['recordRevision'],
    )
    if (row === undefined || row.objectId !== candidate['objectId'] || covered.has(row.recordId))
      throw invalid()
    covered.add(row.recordId)
    result.push({
      candidateId: candidate['candidateId'],
      jobId: candidate['jobId'],
      objectId: candidate['objectId'],
      documentId,
    })
  }
  if (new Set(result.map((candidate) => candidate.candidateId)).size !== result.length) throw invalid()
  return result
}
