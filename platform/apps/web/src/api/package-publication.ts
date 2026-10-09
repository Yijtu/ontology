import type {
  CapabilityRequirement,
  DefinitionRevisionStrategy,
  ResourceRef,
  RevisionString,
  VersionRef,
} from '@ontology/contracts'

/**
 * Wire shapes for the package validation / publish / export / mount surface (V03-021 / #202,
 * SPEC v0.3a asset-data-ui §6.1/§9, SPEC generic-assistants-core v0.3 §4.3).
 *
 * The browser reads the synthetic counter-examples, the industry validation report and the
 * immutable pack export over HTTP and validates every shape at runtime. `semanticPublished`
 * (a definition/rule/action may be published) and `deploymentExecutable` (a registered
 * implementation can actually run) are kept apart so a semantically published pack with
 * unbound actions is never presented as executable. Nothing here carries a customer instance,
 * a real price table or a credential: the export is declaration data only.
 */

export type PackageValidationSurface = 'semantic' | 'deployment'

export const SYNTHETIC_CASE_KINDS = [
  'missing_parameter',
  'same_name_different_meaning',
  'contradiction',
  'wrong_unit',
  'missing_capability',
] as const
export type SyntheticCaseKind = (typeof SYNTHETIC_CASE_KINDS)[number]

export const SYNTHETIC_CASE_KIND_LABELS: Readonly<Record<SyntheticCaseKind, string>> = {
  missing_parameter: '缺参数',
  same_name_different_meaning: '同名异物',
  contradiction: '冲突',
  wrong_unit: '错单位',
  missing_capability: '缺能力',
}

export const ISOLATION_LABEL = 'synthetic test' as const

export interface SyntheticCaseFieldView {
  readonly fieldId: string
  readonly value: string | number | boolean | null
  readonly unitCode?: string
}

export interface SyntheticCaseView {
  readonly caseId: string
  readonly caseKind: SyntheticCaseKind
  readonly objectTypeRef: string
  readonly displayName?: string
  readonly alternateObjectTypeRef?: string
  readonly fields: readonly SyntheticCaseFieldView[]
  readonly note?: string
}

export interface SyntheticExpectationView {
  readonly expectationId: string
  readonly caseId: string
  readonly kind: 'rule' | 'action'
  readonly ruleId?: string
  readonly actionId?: string
  readonly expected: string
  /** Only `expert_confirmed` and `authored_oracle` are independent (SPEC §3.4). */
  readonly origin: string
  readonly reason: string
}

/** One immutable, isolation-marked synthetic example set version (counter-example sandbox). */
export interface SyntheticExampleSetView {
  readonly exampleSetId: string
  readonly workspaceId: string
  readonly sourceKind: 'synthetic'
  readonly dataMode: 'synthetic'
  readonly isolationLabel: typeof ISOLATION_LABEL
  /** The draft revision the set validates; its `version` carries the revision string. */
  readonly targetDraftRef?: VersionRef
  readonly caseKinds: readonly SyntheticCaseKind[]
  readonly cases: readonly SyntheticCaseView[]
  readonly expectations: readonly SyntheticExpectationView[]
  readonly contentDigest: string
  readonly recordedAt: string
}

export interface IndustryValidationIssueView {
  readonly code: string
  readonly surface: PackageValidationSurface
  readonly message: string
  readonly caseId?: string
  readonly ruleId?: string
  readonly actionId?: string
  readonly logicalId?: string
}

/** One validation surface; the two surfaces are always reported independently. */
export interface ValidationSurfaceGateView {
  readonly passed: boolean
  readonly blockers: readonly IndustryValidationIssueView[]
}

export interface SyntheticExpectationResultView {
  readonly expectationId: string
  readonly caseId: string
  readonly kind: 'rule' | 'action'
  readonly targetId: string
  readonly expected: string
  readonly actual: string
  readonly matched: boolean
  readonly origin: string
  readonly independent: boolean
}

export interface SyntheticCaseCoverageView {
  readonly caseId: string
  readonly caseKind: SyntheticCaseKind
  readonly ruleIds: readonly string[]
  readonly actionIds: readonly string[]
}

export type IndustryValidationGate = 'open' | 'blocked_semantic' | 'blocked_execution' | 'blocked_both'

/** The industry validation report the workbench reads to gate publication (V03-014). */
export interface CompetencyResultView {
  readonly questionId: string
  readonly question: string
  readonly status: 'passed' | 'failed' | 'not_yet_executable'
  readonly expected: unknown
  readonly actual?: unknown
  readonly reason?: string
  readonly sourceCoverage: { readonly required: number; readonly verified: number; readonly complete: boolean }
}
export interface IndustryValidationReportView {
  readonly competencyQuestionRef?: VersionRef
  readonly competencyRequired?: true
  readonly competency?: { readonly passed: boolean; readonly results: readonly CompetencyResultView[] }
  readonly strategy?: DefinitionRevisionStrategy
  readonly validationId: string
  readonly workspaceId: string
  readonly revision: RevisionString
  readonly exampleSetId: string
  readonly exampleSetRef: ResourceRef
  readonly dataMode: 'synthetic'
  readonly isolationLabel: typeof ISOLATION_LABEL
  readonly businessApproval: 'none'
  readonly realFactsWritten: false
  readonly semanticPublished: ValidationSurfaceGateView
  readonly deploymentExecutable: ValidationSurfaceGateView
  readonly publishable: boolean
  readonly gate: IndustryValidationGate
  readonly issues: readonly IndustryValidationIssueView[]
  readonly expectationResults: readonly SyntheticExpectationResultView[]
  readonly coverage: readonly SyntheticCaseCoverageView[]
  readonly contentDigest: string
  readonly recordedAt: string
}

export interface PackActionDeclarationPinView {
  readonly actionId: string
  readonly declarationRef: ResourceRef
  readonly bindingStatus: string
  readonly executable: boolean
  readonly requiredCapabilities: readonly CapabilityRequirement[]
  readonly missingCapabilities: readonly string[]
}

/** The two-surface capability state of a published pack (SPEC §4.2/§6.1). */
export interface PackCapabilityStatusView {
  readonly semanticPublished: boolean
  readonly deploymentExecutable: boolean
  readonly requiredCapabilities: readonly string[]
  readonly missingCapabilities: readonly string[]
  readonly actions: readonly PackActionDeclarationPinView[]
}

export interface PackVersionChangeView {
  readonly scope: string
  readonly change: string
  readonly logicalId: string
  readonly breaking: boolean
  readonly message: string
  readonly before?: string
  readonly after?: string
}

export interface PackVersionDiffView {
  readonly fromPackRef?: VersionRef
  readonly toPackRef: VersionRef
  readonly changes: readonly PackVersionChangeView[]
  readonly breakingChanges: readonly PackVersionChangeView[]
  readonly digest: string
}

export interface PublishedPackResultView {
  readonly packRef: VersionRef
  readonly capabilities: PackCapabilityStatusView
  readonly revision: RevisionString
  readonly publishedAt: string
}

export interface PackExportBundleView {
  readonly exportVersion: string
  readonly packRef: VersionRef
  readonly namespace: string
  readonly maturity: string
  readonly maturityLabel: string
  readonly usable: boolean
  readonly mappingTemplates: readonly unknown[]
  readonly capabilityStatus?: PackCapabilityStatusView
  readonly versionDiff?: PackVersionDiffView
  readonly exportedAt: string
  readonly contentDigest: string
}

export interface RunValidationRequest {
  readonly exampleSetId: string
  /** The head revision the caller read; omitted means no `If-Match` was sent. */
  readonly expectedRevision?: RevisionString
  readonly competencyQuestionRef?: VersionRef
  readonly strategy?: DefinitionRevisionStrategy
}

export interface PublishPackRequest {
  readonly packId: string
  readonly version: string
  readonly validationId: string
  /** Refuse a pack whose deployment surface is not fully executable instead of publishing it. */
  readonly requireDeploymentExecutable: boolean
  readonly expectedRevision: RevisionString
  readonly strategy?: DefinitionRevisionStrategy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && isNonEmptyString(value['id']) && isNonEmptyString(value['version']) && isSha256(value['digest'])
}

export function isCaseKind(value: unknown): value is SyntheticCaseKind {
  return typeof value === 'string' && (SYNTHETIC_CASE_KINDS as readonly string[]).includes(value)
}

function isCaseField(value: unknown): value is SyntheticCaseFieldView {
  if (!isRecord(value) || !isNonEmptyString(value['fieldId'])) return false
  const raw = value['value']
  if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return false
  return value['unitCode'] === undefined || typeof value['unitCode'] === 'string'
}

function isCase(value: unknown): value is SyntheticCaseView {
  return isRecord(value) && isNonEmptyString(value['caseId']) && isCaseKind(value['caseKind']) &&
    isNonEmptyString(value['objectTypeRef']) && Array.isArray(value['fields']) &&
    value['fields'].every(isCaseField)
}

function isExpectation(value: unknown): value is SyntheticExpectationView {
  return isRecord(value) && isNonEmptyString(value['expectationId']) && isNonEmptyString(value['caseId']) &&
    (value['kind'] === 'rule' || value['kind'] === 'action') && isNonEmptyString(value['expected']) &&
    isNonEmptyString(value['origin']) && typeof value['reason'] === 'string'
}

export function isSyntheticExampleSetView(value: unknown): value is SyntheticExampleSetView {
  return isRecord(value) && isNonEmptyString(value['exampleSetId']) && isNonEmptyString(value['workspaceId']) &&
    value['sourceKind'] === 'synthetic' && value['dataMode'] === 'synthetic' &&
    value['isolationLabel'] === ISOLATION_LABEL &&
    (value['targetDraftRef'] === undefined || isVersionRef(value['targetDraftRef'])) &&
    Array.isArray(value['caseKinds']) &&
    value['caseKinds'].every(isCaseKind) && Array.isArray(value['cases']) && value['cases'].every(isCase) &&
    Array.isArray(value['expectations']) && value['expectations'].every(isExpectation) &&
    isSha256(value['contentDigest']) && typeof value['recordedAt'] === 'string'
}

function isIssue(value: unknown): value is IndustryValidationIssueView {
  return isRecord(value) && isNonEmptyString(value['code']) &&
    (value['surface'] === 'semantic' || value['surface'] === 'deployment') &&
    typeof value['message'] === 'string'
}

function isSurfaceGate(value: unknown): value is ValidationSurfaceGateView {
  return isRecord(value) && typeof value['passed'] === 'boolean' &&
    Array.isArray(value['blockers']) && value['blockers'].every(isIssue)
}

function isExpectationResult(value: unknown): value is SyntheticExpectationResultView {
  return isRecord(value) && isNonEmptyString(value['expectationId']) && isNonEmptyString(value['caseId']) &&
    (value['kind'] === 'rule' || value['kind'] === 'action') && isNonEmptyString(value['targetId']) &&
    isNonEmptyString(value['expected']) && isNonEmptyString(value['actual']) &&
    typeof value['matched'] === 'boolean' && isNonEmptyString(value['origin']) &&
    typeof value['independent'] === 'boolean'
}

function isCoverage(value: unknown): value is SyntheticCaseCoverageView {
  return isRecord(value) && isNonEmptyString(value['caseId']) && isCaseKind(value['caseKind']) &&
    isStringArray(value['ruleIds']) && isStringArray(value['actionIds'])
}

function isCompetencyResult(value: unknown): value is CompetencyResultView {
  if (!isRecord(value) || !isNonEmptyString(value['questionId']) || !isNonEmptyString(value['question']) ||
    typeof value['status'] !== 'string' || !['passed', 'failed', 'not_yet_executable'].includes(value['status']) || value['expected'] === undefined ||
    (value['reason'] !== undefined && typeof value['reason'] !== 'string') || !isRecord(value['sourceCoverage'])) return false
  const { required, verified, complete } = value['sourceCoverage']
  return typeof required === 'number' && Number.isSafeInteger(required) && required >= 0 &&
    typeof verified === 'number' && Number.isSafeInteger(verified) && verified >= 0 && verified <= required &&
    typeof complete === 'boolean' && (!complete || verified === required)
}
function isCompetency(value: unknown): boolean {
  return isRecord(value) && typeof value['passed'] === 'boolean' && Array.isArray(value['results']) && value['results'].every(isCompetencyResult)
}
export function isIndustryValidationReportView(value: unknown): value is IndustryValidationReportView {
  return isRecord(value) && isNonEmptyString(value['validationId']) && isNonEmptyString(value['workspaceId']) &&
    typeof value['revision'] === 'string' && isNonEmptyString(value['exampleSetId']) &&
    value['dataMode'] === 'synthetic' && value['isolationLabel'] === ISOLATION_LABEL &&
    value['businessApproval'] === 'none' && value['realFactsWritten'] === false &&
    isSurfaceGate(value['semanticPublished']) && isSurfaceGate(value['deploymentExecutable']) &&
    typeof value['publishable'] === 'boolean' &&
    (value['gate'] === 'open' || value['gate'] === 'blocked_semantic' ||
      value['gate'] === 'blocked_execution' || value['gate'] === 'blocked_both') &&
    Array.isArray(value['issues']) && value['issues'].every(isIssue) &&
    Array.isArray(value['expectationResults']) && value['expectationResults'].every(isExpectationResult) &&
    Array.isArray(value['coverage']) && value['coverage'].every(isCoverage) &&
    isSha256(value['contentDigest']) && typeof value['recordedAt'] === 'string' &&
    (value['competencyQuestionRef'] === undefined || isVersionRef(value['competencyQuestionRef'])) &&
    (value['competencyRequired'] === undefined || value['competencyRequired'] === true) &&
    (value['competency'] === undefined || isCompetency(value['competency']))
}

function isActionPin(value: unknown): value is PackActionDeclarationPinView {
  return isRecord(value) && isNonEmptyString(value['actionId']) && typeof value['bindingStatus'] === 'string' &&
    typeof value['executable'] === 'boolean' && Array.isArray(value['requiredCapabilities']) &&
    isStringArray(value['missingCapabilities'])
}

export function isPackCapabilityStatusView(value: unknown): value is PackCapabilityStatusView {
  return isRecord(value) && typeof value['semanticPublished'] === 'boolean' &&
    typeof value['deploymentExecutable'] === 'boolean' && isStringArray(value['requiredCapabilities']) &&
    isStringArray(value['missingCapabilities']) && Array.isArray(value['actions']) &&
    value['actions'].every(isActionPin)
}

function isVersionChange(value: unknown): value is PackVersionChangeView {
  return isRecord(value) && isNonEmptyString(value['scope']) && isNonEmptyString(value['change']) &&
    isNonEmptyString(value['logicalId']) && typeof value['breaking'] === 'boolean' &&
    typeof value['message'] === 'string'
}

function isVersionDiff(value: unknown): value is PackVersionDiffView {
  return isRecord(value) && isVersionRef(value['toPackRef']) && Array.isArray(value['changes']) &&
    value['changes'].every(isVersionChange) && Array.isArray(value['breakingChanges']) &&
    value['breakingChanges'].every(isVersionChange) && isSha256(value['digest'])
}

export function isPublishedPackResult(value: unknown): value is PublishedPackResultView {
  return isRecord(value) && isVersionRef(value['packRef']) && isPackCapabilityStatusView(value['capabilities']) &&
    typeof value['revision'] === 'string' && typeof value['publishedAt'] === 'string'
}

export function isPackExportBundleView(value: unknown): value is PackExportBundleView {
  return isRecord(value) && isNonEmptyString(value['exportVersion']) && isVersionRef(value['packRef']) &&
    isNonEmptyString(value['namespace']) && typeof value['maturity'] === 'string' &&
    typeof value['maturityLabel'] === 'string' && typeof value['usable'] === 'boolean' &&
    Array.isArray(value['mappingTemplates']) &&
    (value['capabilityStatus'] === undefined || isPackCapabilityStatusView(value['capabilityStatus'])) &&
    (value['versionDiff'] === undefined || isVersionDiff(value['versionDiff'])) &&
    typeof value['exportedAt'] === 'string' && isSha256(value['contentDigest'])
}
