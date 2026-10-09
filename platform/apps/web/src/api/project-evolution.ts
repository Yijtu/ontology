import { assertProjectEvolutionPlan } from '@ontology/contracts'
import type {
  DefinitionRevisionStrategy,
  ProjectEvolutionRecord,
  ProjectEvolutionRemap,
  VersionRef,
} from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { ApiError } from './errors'
import { isPackExportBundleView } from './package-publication'
import type { PackVersionDiffView } from './package-publication'
import type { ProjectCanonicalObject } from './project-workbench'
import { isResourceRef, isVersionRef } from './projects'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9]+$/u.test(value)
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
const sameRef = (left: VersionRef, right: VersionRef) =>
  left.id === right.id && left.version === right.version && left.digest === right.digest
function malformed(): never {
  throw new ApiError(502, {
    code: 'MALFORMED_RESPONSE',
    message: '演进响应缺少可核对的版本、原始来源或处理边界。',
    retryable: false,
    reasons: [],
    missingCapabilities: [],
  })
}
export interface EvolutionTargetView {
  readonly packRef: VersionRef
  readonly definitionRef: VersionRef
  readonly objects: readonly ProjectCanonicalObject[]
  readonly versionDiff?: PackVersionDiffView
}

/** The existing immutable export contains the exact published definition; no catalogue is invented. */
export async function readEvolutionTarget(
  client: WorkbenchClient,
  ref: VersionRef,
  signal?: AbortSignal,
): Promise<EvolutionTargetView> {
  const path = `/api/v1/industry-packs/${encodeURIComponent(ref.id)}/export?${new URLSearchParams({ version: ref.version }).toString()}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  if (!isPackExportBundleView(value) || !sameRef(value.packRef, ref) || !value.usable || !record(value))
    malformed()
  const definition = value['definitions'],
    manifest = value['manifest']
  if (
    !record(definition) ||
    !isVersionRef(definition['ref']) ||
    !record(manifest) ||
    !isVersionRef(manifest['definitionsRef']) ||
    !sameRef(definition['ref'], manifest['definitionsRef']) ||
    !Array.isArray(definition['objects']) ||
    !Array.isArray(definition['attributes'])
  )
    malformed()
  const attributes = definition['attributes']
  const objects: ProjectCanonicalObject[] = []
  for (const object of definition['objects']) {
    if (!record(object) || typeof object['id'] !== 'string' || typeof object['displayName'] !== 'string')
      malformed()
    const objectId = object['id']
    const fields: ProjectCanonicalObject['attributes'][number][] = []
    for (const attribute of attributes) {
      if (!record(attribute) || typeof attribute['objectId'] !== 'string') malformed()
      if (attribute['objectId'] !== objectId) continue
      if (
        typeof attribute['id'] !== 'string' ||
        typeof attribute['valueType'] !== 'string' ||
        !record(attribute['cardinality']) ||
        !count(attribute['cardinality']['min'])
      )
        malformed()
      const unit = attribute['unit']
      if (unit !== undefined && (!record(unit) || typeof unit['unitCode'] !== 'string')) malformed()
      fields.push({
        attributeId: attribute['id'],
        displayName: attribute['id'],
        valueType: attribute['valueType'],
        required: Number(attribute['cardinality']['min']) > 0,
        ...(record(unit) && typeof unit['unitCode'] === 'string' ? { unit: unit['unitCode'] } : {}),
      })
    }
    objects.push({ objectId, displayName: object['displayName'], attributes: fields })
  }
  if (
    objects.length === 0 ||
    new Set(objects.map((object) => object.objectId)).size !== objects.length ||
    (value.versionDiff?.fromPackRef !== undefined && !isVersionRef(value.versionDiff.fromPackRef))
  )
    malformed()
  return {
    packRef: value.packRef,
    definitionRef: definition['ref'],
    objects,
    ...(value.versionDiff === undefined ? {} : { versionDiff: value.versionDiff }),
  }
}
export function isProjectEvolutionRecord(value: unknown): value is ProjectEvolutionRecord {
  if (
    !record(value) ||
    !revision(value['revision']) ||
    !['queued', 'running', 'awaiting_review', 'needs_human', 'ready', 'failed', 'cancelled'].includes(
      String(value['state']),
    ) ||
    !count(value['attempts']) ||
    !count(value['recordOperations']) ||
    !count(value['batches']) ||
    !Array.isArray(value['candidateIds']) ||
    !value['candidateIds'].every(uuid) ||
    (value['error'] !== undefined && typeof value['error'] !== 'string') ||
    (value['inputSnapshotRef'] !== undefined && !isResourceRef(value['inputSnapshotRef']))
  )
    return false
  try {
    assertProjectEvolutionPlan(value['plan'])
  } catch {
    return false
  }
  if (
    value['snapshots'] !== undefined &&
    (!Array.isArray(value['snapshots']) ||
      !value['snapshots'].every(
        (snapshot: unknown) =>
          record(snapshot) &&
          typeof snapshot['objectId'] === 'string' &&
          isResourceRef(snapshot['snapshotRef']) &&
          typeof snapshot['sourceDigest'] === 'string' &&
          record(snapshot['factRecordedPoint']) &&
          revision(snapshot['factRecordedPoint']['semantic']) &&
          revision(snapshot['factRecordedPoint']['identity']),
      ))
  )
    return false
  return true
}
async function readResult(
  client: WorkbenchClient,
  method: string,
  path: string,
  projectId: string,
  options: Parameters<WorkbenchClient['requestJson']>[2],
): Promise<ProjectEvolutionRecord> {
  const value = await client.requestJson<unknown>(method, path, options)
  if (
    !record(value) ||
    !isProjectEvolutionRecord(value['evolution']) ||
    value['evolution'].plan.previousRevisionRef.projectId !== projectId ||
    value['evolution'].plan.targetRevisionRef.projectId !== projectId
  )
    malformed()
  return value['evolution']
}
export function startProjectEvolution(
  client: WorkbenchClient,
  projectId: string,
  expectedRevision: string,
  body: {
    readonly industryPackRef: VersionRef
    readonly strategy: DefinitionRevisionStrategy
    readonly remappings: readonly ProjectEvolutionRemap[]
    readonly maxRecords: number
    readonly maxAttempts: number
  },
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return readResult(
    client,
    'POST',
    `/api/v1/projects/${encodeURIComponent(projectId)}/evolutions`,
    projectId,
    { body, ifMatch: expectedRevision, idempotencyKey, ...(signal === undefined ? {} : { signal }) },
  )
}
export function readProjectEvolution(
  client: WorkbenchClient,
  projectId: string,
  evolutionId: string,
  signal?: AbortSignal,
) {
  return readResult(
    client,
    'GET',
    `/api/v1/projects/${encodeURIComponent(projectId)}/evolutions/${encodeURIComponent(evolutionId)}`,
    projectId,
    signal === undefined ? {} : { signal },
  )
}
export function operateProjectEvolution(
  client: WorkbenchClient,
  projectId: string,
  evolutionId: string,
  operation: 'activate' | 'cancel' | 'retry',
  relationCandidateIds: readonly string[] = [],
  signal?: AbortSignal,
) {
  return readResult(
    client,
    'POST',
    `/api/v1/projects/${encodeURIComponent(projectId)}/evolutions/${encodeURIComponent(evolutionId)}/${operation}`,
    projectId,
    {
      body: operation === 'activate' ? { relationCandidateIds } : {},
      ...(signal === undefined ? {} : { signal }),
    },
  )
}
