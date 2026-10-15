import {
  isRecord,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isUuid,
  isVersionRef,
} from '@ontology/contracts'
import type {
  AssetDraftCandidateRef,
  AssetDraftVersion,
  IndustryWorkspace,
  IndustryWorkspaceBoundary,
  IndustryWorkspaceState,
  ResourceRef,
  RevisionString,
  Sha256Digest,
  Uuid,
} from '@ontology/contracts'

export interface IndustryWorkspaceListFilter {
  readonly state?: IndustryWorkspaceState
  readonly limit?: number
}

/**
 * Wire shapes for the industry-workspace draft management surface (V03-004, SPEC v0.3a §3.1/§8.1).
 *
 * The browser talks to the API over HTTP only, so these shapes and their runtime guards are
 * declared here instead of importing the application package. Every response is validated with
 * a guard: a well-formed envelope carrying an unrecognised body is an explicit failure, never a
 * guessed workspace that could later be written with the wrong revision.
 */

export interface AssetDraftRef {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly digest: Sha256Digest
}

/** One immutable draft revision plus the workspace metadata head it belongs to. */
export interface IndustryWorkspaceWriteView {
  readonly workspace: IndustryWorkspace
  readonly draftRef: AssetDraftRef
  /** The full draft body; the create route returns it, the edit routes return only the ref. */
  readonly draft?: AssetDraftVersion
  readonly created?: boolean
  readonly changes?: readonly string[]
}

export interface CreateIndustryWorkspaceRequest {
  readonly namespace: string
  readonly displayName: string
  readonly boundary: IndustryWorkspaceBoundary
  /** The immutable source set the first draft was captured from. */
  readonly documentSetRef: ResourceRef
}

export interface EditIndustryWorkspaceRequest {
  /** The head revision the caller last read; the server rejects a mismatch as VERSION_CONFLICT. */
  readonly expectedRevision: RevisionString
  readonly reason: string
  readonly displayName?: string
  readonly boundary?: IndustryWorkspaceBoundary
}

export interface AppendIndustryWorkspaceDraftRequest {
  readonly expectedRevision: RevisionString
  readonly reason: string
  readonly documentSetRef: ResourceRef
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function isIndustryWorkspaceBoundary(value: unknown): value is IndustryWorkspaceBoundary {
  if (!isRecord(value)) return false
  if (!isStringArray(value['goals']) || !isStringArray(value['included']) || !isStringArray(value['excluded'])) {
    return false
  }
  const applicability = value['applicability']
  if (!isRecord(applicability)) return false
  for (const key of ['region', 'validFrom', 'validTo']) {
    const field = applicability[key]
    if (field !== undefined && (typeof field !== 'string' || field.length === 0)) return false
  }
  return true
}

const WORKSPACE_STATES: readonly IndustryWorkspaceState[] = ['draft', 'review', 'published', 'archived']

export function isIndustryWorkspace(value: unknown): value is IndustryWorkspace {
  if (!isRecord(value)) return false
  if (!isUuid(value['workspaceId'])) return false
  if (typeof value['namespace'] !== 'string' || value['namespace'].length === 0) return false
  if (typeof value['displayName'] !== 'string' || value['displayName'].length === 0) return false
  if (!isIndustryWorkspaceBoundary(value['boundary'])) return false
  if (!isRevisionString(value['headRevision'])) return false
  const state = value['state']
  if (typeof state !== 'string' || !(WORKSPACE_STATES as readonly string[]).includes(state)) return false
  const publishedPackRef = value['latestPublishedPackRef']
  if (publishedPackRef !== undefined && !isVersionRef(publishedPackRef)) return false
  return true
}

function isAssetDraftCandidateRef(value: unknown): value is AssetDraftCandidateRef {
  if (!isRecord(value)) return false
  return (
    typeof value['logicalId'] === 'string' &&
    value['logicalId'].length > 0 &&
    isUuid(value['candidateId']) &&
    isSha256Digest(value['digest'])
  )
}

export function isAssetDraftVersion(value: unknown): value is AssetDraftVersion {
  if (!isRecord(value)) return false
  if (!isUuid(value['workspaceId'])) return false
  if (!isRevisionString(value['revision'])) return false
  if (!isSha256Digest(value['digest'])) return false
  if (!isResourceRef(value['documentSetRef'])) return false
  const candidateRefs = value['candidateRefs']
  if (!Array.isArray(candidateRefs) || !candidateRefs.every(isAssetDraftCandidateRef)) return false
  if (value['basePackRef'] !== undefined && !isVersionRef(value['basePackRef'])) return false
  if (value['syntheticExampleSetRef'] !== undefined && !isResourceRef(value['syntheticExampleSetRef'])) return false
  if (value['validationRef'] !== undefined && !isResourceRef(value['validationRef'])) return false
  return true
}

export function isAssetDraftRef(value: unknown): value is AssetDraftRef {
  if (!isRecord(value)) return false
  return (
    isUuid(value['workspaceId']) &&
    isRevisionString(value['revision']) &&
    isSha256Digest(value['digest'])
  )
}

export function isIndustryWorkspaceWriteView(value: unknown): value is IndustryWorkspaceWriteView {
  if (!isRecord(value)) return false
  if (!isIndustryWorkspace(value['workspace'])) return false
  if (!isAssetDraftRef(value['draftRef'])) return false
  if (value['draft'] !== undefined && !isAssetDraftVersion(value['draft'])) return false
  const created = value['created']
  if (created !== undefined && typeof created !== 'boolean') return false
  const changes = value['changes']
  if (changes !== undefined && !isStringArray(changes)) return false
  return true
}
