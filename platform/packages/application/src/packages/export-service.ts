import { definitionRecordOf, isPackMaturityUsable, packMaturityLabelOf } from '@ontology/contracts'
import type {
  IndustryPackCatalogue,
  IndustryPackExportBundle,
  MappingTemplate,
  MappingTemplateField,
  PackAsset,
  PackIdentityPolicy,
  PublishedPackAsset,
  PublishedPackAssetStore,
  ScopeRef,
  SemanticDefinitionRecord,
  SemanticDefinitionStore,
  Semver,
  ToolContext,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { IndustryPackError } from './errors'
import { assertRole, resolveTrustedScope } from './scope'
import { findPackExportViolations } from './violations'

/** The export wire version. Bump only when the bundle shape changes incompatibly. */
export const PACK_EXPORT_VERSION = '1.0.0'

const EXPORT_ROLES: readonly string[] = ['platform-admin', 'profile-editor']

export interface IndustryPackExportDependencies {
  /** Registered packs and preparation material, supplied by the composition root. */
  readonly catalogue: IndustryPackCatalogue
  /** Published definition versions; the export is rebuilt from these, never from a prototype. */
  readonly definitions: SemanticDefinitionStore
  /**
   * V03-015: the persistent published-pack store. When supplied, a dynamically published pack
   * exports its authorized/redacted source index, pinned action declarations, two-surface
   * capability state and version diff alongside the declaration (SPEC §6.1).
   */
  readonly published?: PublishedPackAssetStore
  readonly now?: () => string
}

export interface ExportPackInput {
  readonly scopeRef: ScopeRef
  readonly packId: string
  readonly version: Semver
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Source-agnostic mapping templates derived from the published definition version: each
 * concept with the canonical fields it must expose. No physical schema, relation or column
 * appears, so the same export can be satisfied by a second, differently shaped source.
 */
export function mappingTemplatesOf(definitions: SemanticDefinitionRecord): MappingTemplate[] {
  return definitions.objects
    .map((object) => ({
      conceptId: object.id,
      namespace: object.namespace,
      fields: definitions.attributes
        .filter((attribute) => attribute.objectId === object.id)
        .map((attribute): MappingTemplateField => {
          const field: MappingTemplateField = {
            fieldRef: attribute.id,
            valueType: attribute.valueType,
            identityKey: attribute.identityKey === true,
          }
          return attribute.unit === undefined
            ? field
            : { ...field, unitCode: attribute.unit.unitCode }
        })
        .sort((left, right) => (left.fieldRef < right.fieldRef ? -1 : left.fieldRef > right.fieldRef ? 1 : 0)),
    }))
    .sort((left, right) => (left.conceptId < right.conceptId ? -1 : left.conceptId > right.conceptId ? 1 : 0))
}

/** The declarative identity policy: declared scope dimensions and identity attributes only. */
export function identityPolicyOf(
  manifest: PackAsset['manifest'],
  definitions: SemanticDefinitionRecord | undefined,
): PackIdentityPolicy {
  if (definitions === undefined) {
    return { policyRef: manifest.identityPolicyRef, scopeDimensions: [], identityAttributeIds: [] }
  }
  return {
    policyRef: manifest.identityPolicyRef,
    scopeDimensions: uniqueSorted(definitions.identityScopes.flatMap((scope) => [...scope.scopeDimensions])),
    identityAttributeIds: uniqueSorted(
      definitions.identityScopes.flatMap((scope) => [...scope.identityAttributeIds]),
    ),
  }
}

function publishedExtrasOf(
  asset: PackAsset,
  published: PublishedPackAsset | undefined,
): Partial<IndustryPackExportBundle> {
  const validationRef = published?.validationRef ?? asset.validationRef
  const syntheticExampleRef = published?.packAsset.syntheticExampleRef ?? asset.syntheticExampleRef
  return {
    ...(published === undefined
      ? {}
      : {
          sourceIndex: published.sourceIndex,
          actionDeclarations: published.capabilities.actions,
          capabilityStatus: published.capabilities,
          versionDiff: published.diff,
        }),
    ...(validationRef === undefined ? {} : { validationRef }),
    ...(syntheticExampleRef === undefined ? {} : { syntheticExampleRef }),
  }
}

function buildExportBundle(
  asset: PackAsset,
  definitions: SemanticDefinitionRecord | undefined,
  exportedAt: string,
  published: PublishedPackAsset | undefined,
): IndustryPackExportBundle {
  const manifest = asset.manifest
  const maturityLabel = packMaturityLabelOf(manifest.maturity)
  const content = {
    exportVersion: PACK_EXPORT_VERSION,
    packRef: asset.ref,
    namespace: manifest.namespace,
    maturity: manifest.maturity,
    maturityLabel,
    usable: isPackMaturityUsable(manifest.maturity),
    manifest,
    ...(definitions === undefined ? {} : { definitions }),
    identityPolicy: identityPolicyOf(manifest, definitions),
    mappingTemplates: definitions === undefined ? [] : mappingTemplatesOf(definitions),
    standardProvenance: manifest.standardProvenance,
    testSuite: asset.testSuite,
    ...(asset.exampleSet === undefined ? {} : { exampleSet: asset.exampleSet }),
    ...publishedExtrasOf(asset, published),
  }
  return { ...content, exportedAt, contentDigest: sha256DigestOf(canonicalJson(content)) }
}

/**
 * Portable pack export (C1, FR-3/4/31/32, US-003/US-023).
 *
 * The export is rebuilt from the published definition version the manifest pins; a digest
 * mismatch is refused rather than silently exported. The result is scanned before it is
 * returned, so an export that would carry customer data, an identity decision or a
 * credential fails with `EXPORT_LEAK_DETECTED` instead of leaking.
 */
export class IndustryPackExportService {
  readonly #catalogue: IndustryPackCatalogue
  readonly #definitions: SemanticDefinitionStore
  readonly #published: PublishedPackAssetStore | undefined
  readonly #now: () => string

  constructor(dependencies: IndustryPackExportDependencies) {
    this.#catalogue = dependencies.catalogue
    this.#definitions = dependencies.definitions
    this.#published = dependencies.published
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async export(input: ExportPackInput, ctx: ToolContext): Promise<IndustryPackExportBundle> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertRole(ctx, EXPORT_ROLES, 'exporting an industry pack')

    const asset = await this.#catalogue.findPack(
      input.packId,
      input.version,
      input.scopeRef,
      ctx,
    )
    if (asset === undefined) {
      throw new IndustryPackError(
        'PACK_NOT_FOUND',
        `industry pack ${input.packId}@${input.version} is not registered in this scope`,
      )
    }

    const definitions = await this.#loadDefinitions(asset, input.scopeRef, ctx)
    const published =
      this.#published === undefined
        ? undefined
        : await this.#published.findPack(input.scopeRef, input.packId, input.version, ctx)
    const bundle = buildExportBundle(asset, definitions, this.#now(), published)
    const violations = findPackExportViolations(bundle)
    if (violations.length > 0) {
      throw new IndustryPackError(
        'EXPORT_LEAK_DETECTED',
        `industry pack ${input.packId} export would leak ${violations.length} non-declaration value(s)`,
        { reasons: violations.map((violation) => `${violation.path} (${violation.code})`) },
      )
    }
    return bundle
  }

  async #loadDefinitions(
    asset: PackAsset,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionRecord | undefined> {
    const ref = asset.manifest.definitionsRef
    const version = await this.#definitions.findVersion(
      asset.manifest.namespace,
      ref.id,
      ref.version,
      scopeRef,
      ctx,
    )
    if (version === undefined) {
      // A pack that claims to be usable must have published its pinned definitions. A
      // preparation pack may legitimately have none, so it exports as declaration-only.
      if (isPackMaturityUsable(asset.manifest.maturity)) {
        throw new IndustryPackError(
          'DEFINITION_NOT_FOUND',
          `definition ${ref.id}@${ref.version} pinned by pack ${asset.ref.id} is not published in this scope`,
        )
      }
      return undefined
    }
    if (version.ref.digest !== ref.digest) {
      throw new IndustryPackError(
        'DEFINITION_NOT_FOUND',
        `definition ${ref.id}@${ref.version} is published with digest ${version.ref.digest}, not the digest ${ref.digest} the pack pins`,
      )
    }
    return definitionRecordOf(version)
  }
}
