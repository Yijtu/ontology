import { isRecord, isResourceRef, isSha256Digest, isVersionRef } from '@ontology/contracts'
import type { AssetDraftVersion, IndustryWorkspace, ResourceRef, ResolvedProfileRef, VersionRef } from '@ontology/contracts'
import { isAssetDraftVersion, isIndustryWorkspace } from './workspaces'
import { invalidWire } from './ontology'
import { parseFormalDefinition, parseTermLabels } from './semantic-authoring'
import type { FormalDefinitionView, TermLabelsView } from './semantic-authoring'
import { parseWorkspaceSource } from './workspace-authoring'
import type { WorkspaceSourceView } from './workspace-authoring'
export interface ExecutionRuleChoice { readonly ref: VersionRef; readonly ruleId: string; readonly objectId: string; readonly displayName: string; readonly sourceRefs: readonly ResourceRef[]; readonly hasBusinessConclusion: boolean }
export interface ExecutionPreviewView {
  readonly purpose: 'synthetic_execution_support'; readonly businessApproval: 'none'
  readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion
  readonly packRef: VersionRef; readonly definitionRef: VersionRef; readonly profileRef: ResolvedProfileRef
  readonly ruleRefs: readonly VersionRef[]; readonly sourceRefs: readonly ResourceRef[]; readonly templateBindingRef: ResourceRef
  readonly definitions: FormalDefinitionView; readonly definitionBody: Readonly<Record<string, unknown>>; readonly termLabels?: TermLabelsView
  readonly ruleChoices: readonly ExecutionRuleChoice[]; readonly sources: readonly WorkspaceSourceView[]
  readonly semanticPublished: true; readonly deploymentExecutable: false
}
export function parseExecutionPreview(value: unknown): ExecutionPreviewView {
  if (!isRecord(value) || value['purpose'] !== 'synthetic_execution_support' || value['businessApproval'] !== 'none' || value['semanticPublished'] !== true || value['deploymentExecutable'] !== false || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || value['workspace'].workspaceId !== value['draft'].workspaceId || value['workspace'].headRevision !== value['draft'].revision || !isVersionRef(value['packRef']) || !isVersionRef(value['definitionRef']) || !isResourceRef(value['templateBindingRef']) || !Array.isArray(value['ruleRefs']) || !value['ruleRefs'].every(isVersionRef) || !Array.isArray(value['sourceRefs']) || !value['sourceRefs'].every(isResourceRef) || !isRecord(value['definitions']) || !isVersionRef(value['definitions']['ref']) || (value['definitions']['ref'].id !== value['definitionRef'].id || value['definitions']['ref'].version !== value['definitionRef'].version || value['definitions']['ref'].digest !== value['definitionRef'].digest) || !isRecord(value['profileRef']) || typeof value['profileRef']['id'] !== 'string' || typeof value['profileRef']['version'] !== 'string' || !isSha256Digest(value['profileRef']['snapshotHash'])) return invalidWire()
  const definitions = parseFormalDefinition(value['definitions'])
  const termLabels = value['termLabels'] === undefined ? undefined : parseTermLabels(value['termLabels'], definitions)
  if (!Array.isArray(value['sources']) || value['sources'].length > 64 || !Array.isArray(value['ruleChoices']) || value['ruleChoices'].length > 16) return invalidWire()
  const sources = value['sources'].map(parseWorkspaceSource), same = (a: VersionRef, b: VersionRef) => a.id === b.id && a.version === b.version && a.digest === b.digest
  const ruleRefs = value['ruleRefs'], sourceRefs = value['sourceRefs']
  const ruleChoices = value['ruleChoices'].map((rule: unknown): ExecutionRuleChoice => {
    if (!isRecord(rule) || !isVersionRef(rule['ref']) || typeof rule['ruleId'] !== 'string' || !rule['ruleId'].trim() || typeof rule['objectId'] !== 'string' || !definitions.objects.some((object) => object.objectId === rule['objectId']) || typeof rule['displayName'] !== 'string' || !rule['displayName'].trim() || !Array.isArray(rule['sourceRefs']) || !rule['sourceRefs'].every(isResourceRef) || typeof rule['hasBusinessConclusion'] !== 'boolean') return invalidWire()
    return { ref: rule['ref'], ruleId: rule['ruleId'], objectId: rule['objectId'], displayName: rule['displayName'], sourceRefs: rule['sourceRefs'], hasBusinessConclusion: rule['hasBusinessConclusion'] }
  })
  if (ruleChoices.length !== ruleRefs.length || new Set(ruleChoices.map((rule) => rule.ruleId)).size !== ruleChoices.length || new Set(ruleChoices.map((rule) => `${rule.ref.id}:${rule.ref.version}:${rule.ref.digest}`)).size !== ruleChoices.length || ruleChoices.some((rule) => !ruleRefs.some((ref: VersionRef) => same(ref, rule.ref)) || rule.sourceRefs.some((ref) => !sources.some((source) => same(source.sourceRef, ref)))) || sources.length !== sourceRefs.length || sources.some((source) => !sourceRefs.some((ref: ResourceRef) => same(source.sourceRef, ref)))) return invalidWire()
  return { purpose: value['purpose'], businessApproval: value['businessApproval'], workspace: value['workspace'], draft: value['draft'], packRef: value['packRef'], definitionRef: value['definitionRef'], profileRef: { id: value['profileRef']['id'], version: value['profileRef']['version'], snapshotHash: value['profileRef']['snapshotHash'] }, ruleRefs, ruleChoices, sourceRefs, sources, templateBindingRef: value['templateBindingRef'], definitions, definitionBody: value['definitions'], ...(termLabels === undefined ? {} : { termLabels }), semanticPublished: true, deploymentExecutable: false }
}
