import type {
  IndustryManifest,
  IndustryMaturity,
  LogicalRole,
  MappingRef,
  Namespace,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  StandardProvenance,
  UnitCode,
  VersionRef,
} from './generated/contracts'
import type { ScopeRef } from './generated/contracts'
import type { AttributeValueType, SemanticDefinitionRecord } from './semantic-definitions'
import type { ToolContext } from './trusted'

/**
 * Portable industry-pack assets (SPEC C1, FR-3/4/31/32, US-003/US-023).
 *
 * An export is declaration data only: the pinned definition version, the identity policy,
 * source-agnostic mapping templates, the cited standard provenance and the pack's test
 * suite. It never carries a customer instance, an identity decision or a credential. The
 * concrete physical mapping stays in the deployment profile, which is what makes the same
 * export usable with a second, differently shaped source structure.
 *
 * The types live in `contracts` next to `IndustryManifest`/`ComponentRegistryStore` so an
 * adapter or the composition root can implement `IndustryPackCatalogue` while depending on
 * `contracts` alone (SPEC §2: adapters → contracts).
 */

/**
 * Readiness label derived from the canonical `IndustryMaturity`. The task vocabulary names
 * the preparation states `defined`/`experimental`; the canonical schema names them
 * `planned`/`preview`. A declaration is only ever reported as `validated` when its maturity
 * is `stable`, so preparation material can never be presented as a validated capability.
 */
export type PackMaturityLabel = 'defined' | 'experimental' | 'validated' | 'deprecated'

const MATURITY_LABELS: Readonly<Record<IndustryMaturity, PackMaturityLabel>> = {
  planned: 'defined',
  preview: 'experimental',
  stable: 'validated',
  deprecated: 'deprecated',
}

export function packMaturityLabelOf(maturity: IndustryMaturity): PackMaturityLabel {
  return MATURITY_LABELS[maturity]
}

/**
 * Only a `stable` pack may be reported as usable. `planned`/`preview` are preparation
 * material: they can be listed and exported, but never bound to a run as if validated.
 */
export function isPackMaturityUsable(maturity: IndustryMaturity): boolean {
  return maturity === 'stable'
}

/** One canonical field a mapping template must be able to answer, with no physical name. */
export interface MappingTemplateField {
  /** Canonical semantic field id; also the output column alias after mapping. */
  readonly fieldRef: string
  readonly valueType: AttributeValueType
  /** Canonical unit. Required for `quantity`, forbidden otherwise. */
  readonly unitCode?: UnitCode
  readonly identityKey: boolean
}

/**
 * A source-agnostic concept template. It names the canonical concept and the canonical
 * fields it must expose; a deployment mapping resolves it to a physical source object and
 * columns. Two differently shaped sources can both satisfy the same template, which is the
 * portability guarantee the export makes.
 */
export interface MappingTemplate {
  readonly conceptId: string
  readonly namespace: Namespace
  readonly fields: readonly MappingTemplateField[]
}

/**
 * The declarative identity policy of a pack: the scope dimensions and identity attribute
 * ids its definitions declare. Identity *decisions* (which real entity a candidate was
 * resolved to) are customer data and are deliberately absent.
 */
export interface PackIdentityPolicy {
  readonly policyRef: VersionRef
  readonly scopeDimensions: readonly string[]
  readonly identityAttributeIds: readonly string[]
}

/** One declarative acceptance case of a pack; references capabilities, never sources. */
export interface PackTestCase {
  readonly caseId: string
  readonly question: string
  readonly expectedCapabilities: readonly string[]
  readonly expectedStatus: 'resolved' | 'missing_capabilities'
}

export interface PackTestSuite {
  readonly ref: VersionRef
  readonly cases: readonly PackTestCase[]
}

/** A registered pack: the industry ref profiles bind plus its declaration and test suite. */
export interface PackAsset {
  readonly ref: VersionRef
  readonly manifest: IndustryManifest
  readonly testSuite: PackTestSuite
}

/**
 * Preparation material for an industry that is not yet ready. It declares its intended
 * provenance and capabilities but owns no published definitions, so it can never resolve.
 */
export interface IndustryPackPreparation {
  readonly namespace: Namespace
  readonly displayName: string
  readonly maturity: IndustryMaturity
  readonly standardProvenance: readonly StandardProvenance[]
  readonly intendedCapabilities: readonly string[]
  readonly note: string
}

export type PackCatalogEntry =
  | { readonly kind: 'registered_pack'; readonly asset: PackAsset }
  | { readonly kind: 'preparation'; readonly preparation: IndustryPackPreparation }

/** The maturity-gated view the API/UI reports; `usable` is derived, never copied. */
export interface PackCatalogSummary {
  readonly kind: 'registered_pack' | 'preparation'
  readonly namespace: Namespace
  readonly displayName: string
  readonly packRef?: VersionRef
  readonly maturity: IndustryMaturity
  readonly maturityLabel: PackMaturityLabel
  readonly usable: boolean
}

/**
 * The catalogue of packs and preparation material. The composition root owns it; the
 * application layer receives it by injection and never imports an industry pack.
 */
export interface IndustryPackCatalogue {
  listEntries(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly PackCatalogEntry[]>
  findPack(
    packId: string,
    version: Semver,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<PackAsset | undefined>
}

/**
 * The portable export of one pack. `contentDigest` is the deterministic hash of everything
 * except `exportedAt`, so two exports of the same published definitions are byte-identical
 * and a changed definition produces a new digest. `definitions` is absent for preparation
 * material that has not published a definition version.
 */
export interface IndustryPackExportBundle {
  readonly exportVersion: Semver
  readonly packRef: VersionRef
  readonly namespace: Namespace
  readonly maturity: IndustryMaturity
  readonly maturityLabel: PackMaturityLabel
  readonly usable: boolean
  readonly manifest: IndustryManifest
  readonly definitions?: SemanticDefinitionRecord
  readonly identityPolicy: PackIdentityPolicy
  readonly mappingTemplates: readonly MappingTemplate[]
  readonly standardProvenance: readonly StandardProvenance[]
  readonly testSuite: PackTestSuite
  readonly exportedAt: Rfc3339UtcTimestamp
  readonly contentDigest: Sha256Digest
}

/**
 * The slots a pack upgrade can change. Each slot maps to exactly one field of `ProfileSpec`,
 * and a change always produces a new profile version rather than mutating an existing one.
 */
export type UpgradeSlot =
  | { readonly kind: 'industry' }
  | { readonly kind: 'runtime' }
  | { readonly kind: 'policy' }
  | { readonly kind: 'backend_binding'; readonly role: LogicalRole }
  | { readonly kind: 'mapping'; readonly mappingId: string }

export interface UpgradeRequest {
  readonly scopeRef: ScopeRef
  readonly packId: string
  readonly sourceProfileRef: { readonly id: string; readonly version: Semver }
  readonly targetProfileRef: { readonly id: string; readonly version: Semver }
  readonly slot: UpgradeSlot
  readonly targetRef: VersionRef
  /** Required for a `mapping` slot; the full role/source mapping template instance. */
  readonly targetMappingRef?: MappingRef
}

export type UpgradeBlockerCode =
  | 'TARGET_VERSION_RETIRED'
  | 'TARGET_VERSION_DIGEST_MISMATCH'
  | 'UPGRADE_PREFLIGHT_FAILED'

export type RetirementBlockerCode =
  | 'VERSION_NOT_FOUND'
  | 'VERSION_ALREADY_RETIRED'
  | 'VERSION_NOT_DEPRECATED'
  | 'ACTIVE_REFERENCE_EXISTS'

export interface UpgradeBlocker<Code extends string = string> {
  readonly code: Code
  readonly message: string
  /** Whether a next action can clear the blocker. A retired version is not recoverable. */
  readonly recoverable: boolean
  readonly nextAction: string
}

export interface UpgradeAssessment {
  readonly status: 'applicable' | 'blocked'
  readonly sourceProfileRef: { readonly id: string; readonly version: Semver }
  readonly slot: UpgradeSlot
  readonly fromRef: VersionRef
  readonly targetRef: VersionRef
  readonly blockers: readonly UpgradeBlocker<UpgradeBlockerCode>[]
}

export interface UpgradeOutcome {
  readonly status: 'applicable' | 'blocked'
  readonly assessment: UpgradeAssessment
  /** The newly published profile version; a binding change only creates a new version. */
  readonly published?: {
    readonly profileRef: { readonly id: string; readonly version: Semver }
    readonly digest: Sha256Digest
    readonly createdAt: Rfc3339UtcTimestamp
  }
  readonly preflightStatus?: 'resolved' | 'missing_capabilities' | 'incompatible'
  readonly blockers: readonly UpgradeBlocker<UpgradeBlockerCode>[]
}

export interface RetirementAssessment {
  readonly status: 'removable' | 'blocked'
  readonly key: { readonly kind: string; readonly id: string; readonly version: Semver }
  readonly blockers: readonly UpgradeBlocker<RetirementBlockerCode>[]
}
