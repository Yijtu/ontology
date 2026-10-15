import type { DefinitionRevisionStrategy } from './definition-editing'
import type { ColumnMappingEntry } from './project-mapping'
import type { ProjectRevisionRef, MappingRef, ResourceRef, ScopeRef, Uuid, RevisionString, Sha256Digest } from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isUuid, isRevisionString, isSha256Digest, isResourceRef, isVersionRef } from './asset-workspace'
export const PROJECT_EVOLUTION_TOPIC = 'project.evolution.requested'
export type ProjectEvolutionState = 'queued' | 'running' | 'awaiting_review' | 'needs_human' | 'ready' | 'failed' | 'cancelled'
export interface ProjectEvolutionImpact {
    readonly kind: 'attribute' | 'identity' | 'type' | 'unit' | 'relation' | 'object'
    readonly logicalId: string
    readonly change: 'added' | 'changed' | 'removed'
    readonly handling: 'reextract_review' | 'human_relation' | 'retire'
}
export interface ProjectEvolutionSource {
    readonly documentId: Uuid
    readonly membershipRevision: RevisionString
    readonly visibilityEpoch: RevisionString
    readonly originalRef: ResourceRef
    readonly parseId: Uuid
    readonly previousMappingRef: MappingRef
    readonly mappingRef: MappingRef
    readonly objectId: string
    readonly expectedRecords: number
    readonly sourceJobId: Uuid
    readonly rawRecordCount: number
    readonly recordIds: readonly Uuid[]
    readonly previousStatements: readonly {
        readonly statementId: Uuid
        readonly version: RevisionString
    }[]
}
/** Coordination only. Candidates retain the existing review/identity/publication authority. */
export interface ProjectEvolutionPlan {
    /** Actual old-active input captured before this same staging CAS; no prior run is required. */
    readonly previousInputRef?: ResourceRef
    readonly evolutionId: Uuid
    readonly jobId: Uuid
    readonly previousRevisionRef: ProjectRevisionRef
    readonly targetRevisionRef: ProjectRevisionRef
    readonly strategy: DefinitionRevisionStrategy
    readonly impacts: readonly ProjectEvolutionImpact[]
    readonly sources: readonly ProjectEvolutionSource[]
    readonly maxAttempts: number
    readonly maxRecordOperations: number
    readonly maxBatches: number
    readonly requestDigest: Sha256Digest
}
export interface ProjectEvolutionRecord {
    readonly plan: ProjectEvolutionPlan
    readonly revision: RevisionString
    readonly state: ProjectEvolutionState
    readonly attempts: number
    readonly recordOperations: number
    readonly batches: number
    readonly candidateIds: readonly Uuid[]
    readonly snapshots?: readonly ProjectEvolutionSnapshot[]
    /** Real approved rows + human confirmation/review manifests, frozen at activation. */
    readonly inputSnapshotRef?: ResourceRef
    readonly error?: string
}
export interface ProjectEvolutionSnapshot {
    readonly objectId: string
    readonly snapshotRef: ResourceRef
    readonly sourceDigest: Sha256Digest
    readonly factRecordedPoint: {
        readonly semantic: RevisionString
        readonly identity: RevisionString
    }
}
export interface ProjectEvolutionRemap {
    readonly mappingRef: MappingRef
    readonly documentId: Uuid
    readonly objectId: string
    readonly entries: readonly ColumnMappingEntry[]
}
export interface ProjectEvolutionStore {
    get(scope: ScopeRef, projectId: Uuid, evolutionId: Uuid, ctx: ToolContext): Promise<ProjectEvolutionRecord | undefined>
    findByKey(scope: ScopeRef, projectId: Uuid, key: string, ctx: ToolContext): Promise<ProjectEvolutionRecord | undefined>
    claim(scope: ScopeRef, projectId: Uuid, evolutionId: Uuid, ctx: ToolContext): Promise<ProjectEvolutionRecord | undefined>
    checkpoint(scope: ScopeRef, record: ProjectEvolutionRecord, state: 'awaiting_review' | 'needs_human' | 'failed', candidateIds: readonly Uuid[], error: string | undefined, ctx: ToolContext): Promise<ProjectEvolutionRecord>
    cancel(scope: ScopeRef, projectId: Uuid, evolutionId: Uuid, ctx: ToolContext): Promise<ProjectEvolutionRecord>
    retry(scope: ScopeRef, projectId: Uuid, evolutionId: Uuid, ctx: ToolContext): Promise<ProjectEvolutionRecord>
    activate(scope: ScopeRef, record: ProjectEvolutionRecord, snapshots: readonly ProjectEvolutionSnapshot[], inputSnapshotRef: ResourceRef, ctx: ToolContext): Promise<ProjectEvolutionRecord>
    activeRebuild(scope: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ProjectEvolutionRecord | undefined>
    assertSources(scope: ScopeRef, projectId: Uuid, evolutionId: Uuid, ctx: ToolContext): Promise<void>
}
export function assertProjectEvolutionPlan(value: unknown): asserts value is ProjectEvolutionPlan {
    const ref = (v: unknown) => isRecord(v) && isUuid(v.projectId) && isRevisionString(v.revision) && isSha256Digest(v.digest)
    const count = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max
    const mapping = (v: unknown) => isVersionRef(v) && isRecord(v) && typeof v.role === 'string' && isRecord(v.sourceObjectRef)
    const source = (s: unknown) => isRecord(s) && isUuid(s.documentId) && isUuid(s.parseId) && isUuid(s.sourceJobId) && isRevisionString(s.membershipRevision) && isRevisionString(s.visibilityEpoch) && isResourceRef(s.originalRef) && mapping(s.mappingRef) && mapping(s.previousMappingRef) && typeof s.objectId === 'string' && count(s.expectedRecords, 20000) && count(s.rawRecordCount, 20000) &&
        Array.isArray(s.recordIds) && s.recordIds.length === s.expectedRecords && s.recordIds.every(isUuid) && new Set(s.recordIds).size === s.recordIds.length && Array.isArray(s.previousStatements) && s.previousStatements.length >= s.expectedRecords && s.previousStatements.length <= 20000 && s.previousStatements.every((pin) => isRecord(pin) && isUuid(pin.statementId) && isRevisionString(pin.version))
    if (!isRecord(value) || !isUuid(value.evolutionId) || !isUuid(value.jobId) || !ref(value.previousRevisionRef) || !ref(value.targetRevisionRef) || !isSha256Digest(value.requestDigest) ||
        (value.previousInputRef !== undefined && !isResourceRef(value.previousInputRef)) ||
        !isRecord(value.strategy) || !['new_version', 'keep_independent', 'retire_previous'].includes(String(value.strategy.kind)) || typeof value.strategy.reason !== 'string' || value.strategy.reason.trim() === '' ||
        !count(value.maxAttempts, 3) || !count(value.maxRecordOperations, 60000) || !count(value.maxBatches, 330) ||
        !Array.isArray(value.impacts) || value.impacts.length > 1000 || !value.impacts.every((i) => isRecord(i) && ['attribute', 'identity', 'type', 'unit', 'relation', 'object'].includes(String(i.kind)) && typeof i.logicalId === 'string' && ['added', 'changed', 'removed'].includes(String(i.change)) && ['reextract_review', 'human_relation', 'retire'].includes(String(i.handling))) ||
        !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 10 || !value.sources.every(source))
        throw new Error('invalid bounded project evolution plan')
}
