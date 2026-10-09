import { isRecord, isResourceRef, isSha256Digest, isUuid, isVersionRef } from '@ontology/contracts'
import type { AssetDraftVersion, IndustryWorkspace, ParseCoverage, ResourceRef, ScopeRef, VersionRef } from '@ontology/contracts'
import { isAssetDraftVersion, isIndustryWorkspace } from './workspaces'
import { invalidWire } from './ontology'
export interface WorkspaceTableView { readonly tableId: string; readonly name?: string; readonly sheetName?: string; readonly sheetId?: string; readonly headerRow: number; readonly columns: readonly { readonly columnIndex: number; readonly header: string; readonly headerDigest: string }[]; readonly rows: readonly { readonly sourceRowKey: string; readonly cells: readonly { readonly columnIndex: number; readonly raw: string | boolean | null }[] }[] }
export interface WorkspaceSourceView { readonly sourceRef: ResourceRef; readonly name?: string; readonly mediaType?: string; readonly originalMediaType?: string; readonly format?: string; readonly options?: Readonly<Record<string, unknown>>; readonly kind: string; readonly parseId: string; readonly parserVersion: string; readonly status: string; readonly coverage: ParseCoverage; readonly previewCoverage: 'complete' | 'partial'; readonly tables?: readonly WorkspaceTableView[] }
export interface WorkspaceSourceCatalogue { readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion; readonly sources: readonly WorkspaceSourceView[] }
export interface EligibleOperationView { readonly operationRef: { readonly id: string; readonly version: string }; readonly displayName: string; readonly inputSchemaRef: VersionRef; readonly outputSchemaRef: VersionRef; readonly inputSchema: Readonly<Record<string, unknown>>; readonly outputSchema: Readonly<Record<string, unknown>>; readonly requiredCapabilities: readonly string[]; readonly requiredPermissions: readonly string[]; readonly sideEffect: 'none' | 'read_only'; readonly handlerRef: VersionRef; readonly handlerDigest: string; readonly limits: Readonly<Record<string, unknown>> }
export interface WorkspaceAuthoringContext { readonly scopeRef: ScopeRef; readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion; readonly generationPolicyRef: VersionRef; readonly models: { readonly generationEnabled: boolean; readonly decisionEnabled: boolean }; readonly operations: readonly EligibleOperationView[]; readonly generationLimits: { readonly maxOutputTokens: number; readonly maxCandidatesPerCall: number; readonly maxSources: number; readonly sourceContextBytes: number; readonly sourceReadBytes: number; readonly sourceFragments: number } }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidWire(); return value }
function text(value: unknown): string { if (typeof value !== 'string') return invalidWire(); return value }
function strings(value: unknown): readonly string[] { if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) return invalidWire(); return value }
function parseCoverage(value: unknown): ParseCoverage {
  if (!isRecord(value)) return invalidWire()
  const status = value['status']; const completeness = value['completeness']
  if (status !== 'complete' && status !== 'partial' && status !== 'failed' || completeness !== 'complete' && completeness !== 'partial' && completeness !== 'truncated' && completeness !== 'unknown') return invalidWire()
  const totalUnits = integer(value['totalUnits']); const parsedUnits = integer(value['parsedUnits']); const skippedUnits = integer(value['skippedUnits'])
  if (parsedUnits + skippedUnits > totalUnits) return invalidWire()
  return { status, completeness, totalUnits, parsedUnits, skippedUnits, skippedReasons: strings(value['skippedReasons']), notes: strings(value['notes']) }
}
export function parseWorkspaceSource(value: unknown): WorkspaceSourceView {
  if (!isRecord(value) || !isResourceRef(value['sourceRef']) || !isUuid(value['parseId']) || value['previewCoverage'] !== 'complete' && value['previewCoverage'] !== 'partial') return invalidWire()
  const tables = value['tables']
  if (tables !== undefined && !Array.isArray(tables)) return invalidWire()
  return { sourceRef: value['sourceRef'], ...(typeof value['mediaType'] === 'string' ? { mediaType: value['mediaType'] } : {}), ...(typeof value['originalMediaType'] === 'string' ? { originalMediaType: value['originalMediaType'] } : {}), ...(typeof value['format'] === 'string' ? { format: value['format'] } : {}), ...(isRecord(value['options']) ? { options: value['options'] } : {}), ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}), kind: text(value['kind']), parseId: value['parseId'], parserVersion: text(value['parserVersion']), status: text(value['status']), coverage: parseCoverage(value['coverage']), previewCoverage: value['previewCoverage'],
    ...(tables === undefined ? {} : { tables: tables.map((table: unknown): WorkspaceTableView => {
      if (!isRecord(table) || !Array.isArray(table['columns']) || !Array.isArray(table['rows'])) return invalidWire()
      return { tableId: text(table['tableId']), ...(typeof table['name'] === 'string' ? { name: table['name'] } : {}), ...(typeof table['sheetName'] === 'string' ? { sheetName: table['sheetName'] } : {}), ...(typeof table['sheetId'] === 'string' ? { sheetId: table['sheetId'] } : {}), headerRow: integer(table['headerRow']),
        columns: table['columns'].map((column: unknown) => { if (!isRecord(column) || !isSha256Digest(column['headerDigest'])) return invalidWire(); return { columnIndex: integer(column['columnIndex']), header: text(column['header']), headerDigest: column['headerDigest'] } }),
        rows: table['rows'].map((row: unknown) => { if (!isRecord(row) || !Array.isArray(row['cells'])) return invalidWire(); return { sourceRowKey: text(row['sourceRowKey']), cells: row['cells'].map((cell: unknown) => { if (!isRecord(cell)) return invalidWire(); const raw = cell['raw']; if (typeof raw !== 'string' && typeof raw !== 'boolean' && raw !== null) return invalidWire(); return { columnIndex: integer(cell['columnIndex']), raw } }) } }) }
    }) }) }
}
export function parseWorkspaceCorpus(value: unknown): WorkspaceSourceCatalogue {
  if (!isRecord(value) || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || !Array.isArray(value['sources']) || value['draft'].workspaceId !== value['workspace'].workspaceId || value['draft'].revision !== value['workspace'].headRevision) return invalidWire()
  return { workspace: value['workspace'], draft: value['draft'], sources: value['sources'].map(parseWorkspaceSource) }
}
export function parseWorkspaceAuthoring(value: unknown): WorkspaceAuthoringContext {
  if (!isRecord(value) || !isRecord(value['scopeRef']) || !isUuid(value['scopeRef']['tenantId']) || !isUuid(value['scopeRef']['spaceId']) || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || !isVersionRef(value['generationPolicyRef']) || !isRecord(value['models']) || typeof value['models']['generationEnabled'] !== 'boolean' || typeof value['models']['decisionEnabled'] !== 'boolean' || !Array.isArray(value['operations']) || !isRecord(value['generationLimits']) || value['workspace'].workspaceId !== value['draft'].workspaceId || value['workspace'].headRevision !== value['draft'].revision) return invalidWire()
  return { scopeRef: { tenantId: value['scopeRef']['tenantId'], spaceId: value['scopeRef']['spaceId'] }, workspace: value['workspace'], draft: value['draft'], generationPolicyRef: value['generationPolicyRef'], models: { generationEnabled: value['models']['generationEnabled'], decisionEnabled: value['models']['decisionEnabled'] }, generationLimits: { maxOutputTokens: integer(value['generationLimits']['maxOutputTokens']), maxCandidatesPerCall: integer(value['generationLimits']['maxCandidatesPerCall']), maxSources: integer(value['generationLimits']['maxSources']), sourceContextBytes: integer(value['generationLimits']['sourceContextBytes']), sourceReadBytes: integer(value['generationLimits']['sourceReadBytes']), sourceFragments: integer(value['generationLimits']['sourceFragments']) }, operations: value['operations'].map((operation: unknown) => {
    if (!isRecord(operation) || !isRecord(operation['operationRef']) || !isVersionRef(operation['inputSchemaRef']) || !isVersionRef(operation['outputSchemaRef']) || !isVersionRef(operation['handlerRef']) || !isSha256Digest(operation['handlerDigest']) || !isRecord(operation['inputSchema']) || !isRecord(operation['outputSchema']) || !isRecord(operation['limits']) || operation['sideEffect'] !== 'none' && operation['sideEffect'] !== 'read_only') return invalidWire()
    return { operationRef: { id: text(operation['operationRef']['id']), version: text(operation['operationRef']['version']) }, displayName: text(operation['displayName']), inputSchemaRef: operation['inputSchemaRef'], outputSchemaRef: operation['outputSchemaRef'], inputSchema: operation['inputSchema'], outputSchema: operation['outputSchema'], requiredCapabilities: strings(operation['requiredCapabilities']), requiredPermissions: strings(operation['requiredPermissions']), sideEffect: operation['sideEffect'], handlerRef: operation['handlerRef'], handlerDigest: operation['handlerDigest'], limits: operation['limits'] }
  }) }
}
export function encodeOriginalBytes(bytes: Uint8Array): string { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary) }

export function nativeCellText(cell: { readonly raw: string | boolean | null } | undefined): string {
  if (cell === undefined) return '（缺少此格）'
  if (cell.raw === null) return '（原文为 null）'
  if (cell.raw === '') return '（原文为空字符串）'
  return typeof cell.raw === 'boolean' ? cell.raw ? 'true' : 'false' : cell.raw
}
