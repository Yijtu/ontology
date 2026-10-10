import type {
  Namespace,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  StandardProvenance,
  UnitCode,
  VersionRef,
} from './generated/contracts'
import type { RuleComparisonOperator } from './rule-extraction'
import type { ToolContext } from './trusted'

/**
 * Semantic definition model (SPEC D2–D4, C1/C3).
 *
 * A definition version is the published, immutable set of object/attribute/relation/
 * identity-scope/rule-constraint declarations an industry pack or a customer extension
 * contributes. It contains semantics and declarative constraints only: no SDK type, no
 * connection address, no credential and no physical column name (INV-03 / ADR-10). The
 * physical mapping from a logical role to a source object lives in `MappingRef`, which
 * is a deployment concern, not a definition.
 *
 * The model, the persistence port and the store error live in `contracts` next to
 * `ControlRepository`/`ComponentRegistryStore`, so an adapter can implement the port while
 * depending on `contracts` alone (SPEC §2: adapters → contracts).
 */

/** Every definition family shares one id space per kind, inside one published version. */
export type SemanticDefinitionKind =
  | 'object'
  | 'attribute'
  | 'relation'
  | 'identity_scope'
  | 'rule_constraint'

/**
 * US-003 / FR-4: the industry core and a customer extension are separate publications.
 * An extension builds on a core version; it can add semantics but can never shadow or
 * mutate a core definition, and private customer data never enters the shared core.
 */
export type DefinitionLayer = 'industry_core' | 'customer_extension'

/**
 * How many values an attribute may carry. `max: 'unbounded'` is the explicit multi-valued
 * form; a numeric `max` is inclusive. Both bounds are integers, so a malformed or
 * contradictory range is rejected instead of being coerced.
 */
export interface Cardinality {
  readonly min: number
  readonly max: number | 'unbounded'
}

export type AttributeValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'enum'
  | 'quantity'
  | 'reference'

/** Canonical unit plus the physical dimension it measures (e.g. kWh / energy). */
export interface UnitRef {
  readonly unitCode: UnitCode
  readonly dimension: string
}

export interface ObjectDefinition {
  readonly kind: 'object'
  readonly id: string
  readonly namespace: Namespace
  readonly displayName: string
  /** The identity scope this object's instances are unique within; must resolve. */
  readonly identityScopeId: string
  readonly standardProvenance: readonly StandardProvenance[]
}

export interface AttributeDefinition {
  readonly kind: 'attribute'
  readonly id: string
  readonly namespace: Namespace
  /** The object this attribute belongs to; must resolve to an object in the same version. */
  readonly objectId: string
  readonly valueType: AttributeValueType
  readonly cardinality: Cardinality
  /**
   * Marks the attribute as part of a stable identity key. An identity key must be a
   * single required value, so a conflicting cardinality is a publication error.
   */
  readonly identityKey?: boolean
  /** Required for `quantity` and forbidden otherwise. */
  readonly unit?: UnitRef
  /** Required for `enum` and forbidden otherwise. */
  readonly enumValues?: readonly string[]
  /** Required for `reference` and forbidden otherwise; must resolve to an object. */
  readonly referencesObjectId?: string
  readonly standardProvenance: readonly StandardProvenance[]
}

export interface RelationDefinition {
  readonly kind: 'relation'
  readonly id: string
  readonly namespace: Namespace
  readonly fromObjectId: string
  readonly toObjectId: string
  /** Cardinality from the `from` object to the `to` object. */
  readonly cardinality: Cardinality
  readonly standardProvenance: readonly StandardProvenance[]
}

/**
 * D4: native identifiers are only unique inside a declared scope (source/site/type
 * namespace). The scope names the dimensions and the attributes that form the key.
 */
export interface IdentityScopeDefinition {
  readonly kind: 'identity_scope'
  readonly id: string
  readonly namespace: Namespace
  readonly objectId: string
  readonly scopeDimensions: readonly string[]
  readonly identityAttributeIds: readonly string[]
  readonly standardProvenance: readonly StandardProvenance[]
}

export type RuleExpression =
  | { readonly op: 'all'; readonly operands: readonly RuleExpression[] }
  | { readonly op: 'any'; readonly operands: readonly RuleExpression[] }
  | { readonly op: 'not'; readonly operand: RuleExpression }
  | {
      readonly op: 'compare'
      readonly attributeId: string
      readonly operator: RuleComparisonOperator
      readonly value: string | number | boolean
    }
  | {
      readonly op: 'range'
      readonly attributeId: string
      readonly min?: number
      readonly max?: number
      readonly unit?: UnitRef
    }
  | { readonly op: 'relation'; readonly relationId: string }

/**
 * A declarative constraint (D5). The first version supports typed all/any, explicit
 * attribute comparison, numeric ranges and confirmed relation queries. An expression
 * that references an undefined object/attribute/relation, or uses an unsupported form,
 * fails publication instead of being silently weakened.
 */
export interface RuleConstraintDefinition {
  readonly kind: 'rule_constraint'
  readonly id: string
  readonly namespace: Namespace
  /** The object the constraint applies to; must resolve. */
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly expression: RuleExpression
  readonly standardProvenance: readonly StandardProvenance[]
}

export type SemanticDefinition =
  | ObjectDefinition
  | AttributeDefinition
  | RelationDefinition
  | IdentityScopeDefinition
  | RuleConstraintDefinition

/**
 * The content of a definition version, before the platform pins its digest and
 * publication time. `ref.digest` is derived from exactly these fields, so two identical
 * drafts resolve to the same immutable version and a changed draft is a new version.
 */
export interface SemanticDefinitionVersionDraft {
  readonly scopeRef: ScopeRef
  readonly definitionId: string
  readonly version: Semver
  readonly namespace: Namespace
  readonly layer: DefinitionLayer
  /**
   * The industry-core version this version builds on. Required for a customer extension;
   * optional for a core version evolving an earlier core version. It always resolves to a
   * core version in the same namespace.
   */
  readonly baseRef?: VersionRef
  readonly standardProvenance: readonly StandardProvenance[]
  readonly objects: readonly ObjectDefinition[]
  readonly attributes: readonly AttributeDefinition[]
  readonly relations: readonly RelationDefinition[]
  readonly identityScopes: readonly IdentityScopeDefinition[]
  readonly ruleConstraints: readonly RuleConstraintDefinition[]
}

/** A published, immutable definition version. A new version is a new record. */
export interface SemanticDefinitionVersion extends SemanticDefinitionVersionDraft {
  readonly ref: VersionRef
  readonly publishedAt: Rfc3339UtcTimestamp
}

/**
 * The persisted declaration: a definition version without the trusted tenant/space scope.
 * Keeping the scope out of the stored body means a shared industry core carries no
 * customer instance data. `ref.digest` pins exactly the declaration content of this body.
 */
export type SemanticDefinitionRecord = Omit<SemanticDefinitionVersion, 'scopeRef'>

/** The existing immutable declaration hash body; audit, scope and version identity stay outside. */
export function semanticDefinitionContent(draft: Pick<SemanticDefinitionVersionDraft, 'namespace' | 'layer' | 'baseRef' | 'standardProvenance' | 'objects' | 'attributes' | 'relations' | 'identityScopes' | 'ruleConstraints'>): Record<string, unknown> {
  return { namespace: draft.namespace, layer: draft.layer, baseRef: draft.baseRef, standardProvenance: draft.standardProvenance,
    objects: draft.objects, attributes: draft.attributes, relations: draft.relations, identityScopes: draft.identityScopes, ruleConstraints: draft.ruleConstraints }
}

export function definitionRecordOf(version: SemanticDefinitionVersion): SemanticDefinitionRecord {
  return {
    ref: version.ref,
    publishedAt: version.publishedAt,
    definitionId: version.definitionId,
    version: version.version,
    namespace: version.namespace,
    layer: version.layer,
    ...(version.baseRef === undefined ? {} : { baseRef: version.baseRef }),
    standardProvenance: version.standardProvenance,
    objects: version.objects,
    attributes: version.attributes,
    relations: version.relations,
    identityScopes: version.identityScopes,
    ruleConstraints: version.ruleConstraints,
  }
}

export function definitionVersionFromRecord(
  record: SemanticDefinitionRecord,
  scopeRef: ScopeRef,
): SemanticDefinitionVersion {
  return { ...record, scopeRef }
}

/**
 * Binds a data set to the exact definition version it was created under. Publishing a
 * newer definition version never rewrites this binding, so older data is not silently
 * reinterpreted against newer semantics (ADR-13 / §6).
 */
export interface DefinitionBinding {
  readonly dataRef: ResourceRef
  /** Namespace the pinned definition version was published under. */
  readonly namespace: Namespace
  readonly definitionRef: VersionRef
  readonly boundAt: Rfc3339UtcTimestamp
}

/** Append-only publication record, mirrored into the control event ledger. */
export interface SemanticDefinitionAudit {
  readonly digest: Sha256Digest
  readonly payloadDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly occurredAt: Rfc3339UtcTimestamp
  readonly actor: string
}

export interface SemanticDefinitionEvent extends SemanticDefinitionAudit {
  readonly definitionId: string
  readonly version: Semver
  readonly namespace: Namespace
  readonly seq: number
}

export interface SemanticDefinitionQuery {
  readonly scopeRef: ScopeRef
  readonly namespace: Namespace
  readonly definitionId: string
  readonly version: Semver
}

export interface SemanticDefinitionListFilter {
  readonly namespace?: Namespace
  readonly layer?: DefinitionLayer
}

export interface BindDataInput {
  readonly scopeRef: ScopeRef
  readonly dataRef: ResourceRef
  readonly namespace: Namespace
  readonly definitionRef: VersionRef
}

export interface ResolveDataDefinitionInput {
  readonly scopeRef: ScopeRef
  readonly dataRefId: string
}

export interface ResolvedDataDefinition {
  readonly binding: DefinitionBinding
  readonly version: SemanticDefinitionVersion
}

/**
 * Persistence-level failures. The service maps these onto `SemanticDefinitionError`; a
 * driver error never escapes the store port.
 *
 * The taxonomy lives next to the port so every implementation — in-memory reference
 * store, PostgreSQL adapter — throws the same class the application layer catches.
 */
export type SemanticDefinitionStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'VERSION_EXISTS'
  | 'VERSION_NOT_FOUND'
  | 'BINDING_EXISTS'
  | 'BINDING_CONFLICT'

export class SemanticDefinitionStoreError extends Error {
  readonly code: SemanticDefinitionStoreErrorCode

  constructor(code: SemanticDefinitionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SemanticDefinitionStoreError'
    this.code = code
  }
}

/**
 * Persistence port for published definition versions (D2/D3).
 *
 * It stores immutable versions, an append-only publication history and the data→version
 * bindings. Every key is tenant/space scoped and `ControlRepository` remains the durable,
 * monotonic event ledger; this port is the reconstructable version projection. A new
 * version is a new row — there is no update path for a published version.
 *
 * The port is declared here, next to `ControlRepository`/`ComponentRegistryStore`, so an
 * adapter can implement it while depending on `contracts` alone (SPEC §2: adapters →
 * contracts). It carries no driver type: `pg` stays inside the adapter.
 */
export interface SemanticDefinitionStore {
  findVersionByRef(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<SemanticDefinitionVersion | undefined>
  findVersion(
    namespace: string,
    definitionId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion | undefined>
  listVersions(
    scopeRef: ScopeRef,
    filter: SemanticDefinitionListFilter,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion[]>
  insertVersion(
    scopeRef: ScopeRef,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    ctx: ToolContext,
  ): Promise<void>
  listEvents(
    scopeRef: ScopeRef,
    definitionId: string,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionEvent[]>
  bindData(scopeRef: ScopeRef, binding: DefinitionBinding, ctx: ToolContext): Promise<void>
  findBinding(
    scopeRef: ScopeRef,
    dataRefId: string,
    ctx: ToolContext,
  ): Promise<DefinitionBinding | undefined>
}
