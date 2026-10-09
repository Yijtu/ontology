import { isRecord, isResourceRef, isSha256Digest, isVersionRef } from '@ontology/contracts'
import type { AssetDraftVersion, IndustryWorkspace, ResourceRef, ResolvedProfileRef, VersionRef } from '@ontology/contracts'
import { isAssetDraftVersion, isIndustryWorkspace } from './workspaces'
import { invalidWire } from './ontology'
export interface ExecutionPreviewView {
  readonly purpose: 'synthetic_execution_support'; readonly businessApproval: 'none'
  readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion
  readonly packRef: VersionRef; readonly definitionRef: VersionRef; readonly profileRef: ResolvedProfileRef
  readonly ruleRefs: readonly VersionRef[]; readonly sourceRefs: readonly ResourceRef[]; readonly templateBindingRef: ResourceRef
  readonly definitions: Readonly<Record<string, unknown>>
  readonly semanticPublished: true; readonly deploymentExecutable: false
}
export function parseExecutionPreview(value: unknown): ExecutionPreviewView {
  if (!isRecord(value) || value['purpose'] !== 'synthetic_execution_support' || value['businessApproval'] !== 'none' || value['semanticPublished'] !== true || value['deploymentExecutable'] !== false || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || value['workspace'].workspaceId !== value['draft'].workspaceId || value['workspace'].headRevision !== value['draft'].revision || !isVersionRef(value['packRef']) || !isVersionRef(value['definitionRef']) || !isResourceRef(value['templateBindingRef']) || !Array.isArray(value['ruleRefs']) || !value['ruleRefs'].every(isVersionRef) || !Array.isArray(value['sourceRefs']) || !value['sourceRefs'].every(isResourceRef) || !isRecord(value['definitions']) || !isVersionRef(value['definitions']['ref']) || (value['definitions']['ref'].id !== value['definitionRef'].id || value['definitions']['ref'].version !== value['definitionRef'].version || value['definitions']['ref'].digest !== value['definitionRef'].digest) || !isRecord(value['profileRef']) || typeof value['profileRef']['id'] !== 'string' || typeof value['profileRef']['version'] !== 'string' || !isSha256Digest(value['profileRef']['snapshotHash'])) return invalidWire()
  return { purpose: value['purpose'], businessApproval: value['businessApproval'], workspace: value['workspace'], draft: value['draft'], packRef: value['packRef'], definitionRef: value['definitionRef'], profileRef: { id: value['profileRef']['id'], version: value['profileRef']['version'], snapshotHash: value['profileRef']['snapshotHash'] }, ruleRefs: value['ruleRefs'], sourceRefs: value['sourceRefs'], templateBindingRef: value['templateBindingRef'], definitions: value['definitions'], semanticPublished: true, deploymentExecutable: false }
}
