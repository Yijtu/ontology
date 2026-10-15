import { definitionRecordOf, isToolContext, isVersionRef } from '@ontology/contracts'
import type {
  IndustryPackCatalogue,
  ComponentRegistryStore,
  PublishedDefinitionVersionReader,
  PublishedPackAssetStore,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { DefinitionPredecessorError, resolvePinnedDefinition } from '../publication/definition-predecessor'
import type { DefinitionPredecessor } from '../publication/definition-predecessor'
import { DefinitionCandidateError } from './errors'
import type { DefinitionTerminologySource, MountedDefinitionTerminology } from './terminology'

export interface DynamicDefinitionTerminologyDependencies {
  /** Authorised catalogue containing dynamic publications and any controlled static seed. */
  readonly catalogue: IndustryPackCatalogue
  readonly definitions: PublishedDefinitionVersionReader
  readonly registry: Pick<ComponentRegistryStore, 'findVersion'>
  readonly publishedPacks?: Pick<PublishedPackAssetStore, 'findByRef'>
}

/** No cache: every read checks the current catalogue visibility and retirement gate. */
export class DynamicDefinitionTerminologySource implements DefinitionTerminologySource {
  readonly #deps: DynamicDefinitionTerminologyDependencies

  constructor(dependencies: DynamicDefinitionTerminologyDependencies) {
    this.#deps = dependencies
  }

  async getTerminology(
    scopeRef: ScopeRef,
    basePackRef: VersionRef | undefined,
    ctx: ToolContext,
  ): Promise<MountedDefinitionTerminology | undefined> {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== scopeRef.tenantId ||
        ctx.allowedResources.tenantId !== scopeRef.tenantId || ctx.allowedResources.spaceId !== scopeRef.spaceId) {
      throw new DefinitionCandidateError('SCOPE_MISMATCH', 'terminology requires the trusted tenant and space scope')
    }
    if (basePackRef === undefined) return undefined
    if (!isVersionRef(basePackRef)) {
      throw new DefinitionCandidateError('INVALID_ARGUMENT', 'the mounted base pack requires a valid id/version/digest pin')
    }
    const pack = await this.#deps.catalogue.findPack(basePackRef.id, basePackRef.version, scopeRef, ctx)
    if (pack === undefined) {
      throw new DefinitionCandidateError('SCHEMA_NOT_FOUND', 'the pinned base pack is missing or not authorised in this scope')
    }
    if (!sameRef(pack.ref, basePackRef)) {
      throw new DefinitionCandidateError('VERSION_CONFLICT', 'the base pack does not match its exact id/version/digest pin')
    }
    if (pack.manifest.maturity === 'deprecated') {
      throw new DefinitionCandidateError('VALIDATION_BLOCKED', 'the pinned base pack is retired')
    }
    const registered = await this.#deps.registry.findVersion({ kind: 'industry_pack', id: basePackRef.id, version: basePackRef.version }, scopeRef, ctx)
    if (registered !== undefined) {
      if (!sameRef(registered.manifestRef, basePackRef) || registered.manifest.kind !== 'industry_pack' ||
          !sameRef(registered.manifest, basePackRef) ||
          (registered.manifest.namespace !== undefined && registered.manifest.namespace !== pack.manifest.namespace)) {
        throw new DefinitionCandidateError('VERSION_CONFLICT', 'the registered base pack does not match its exact pin or namespace')
      }
      if (registered.manifest.trustStatus === 'revoked') {
        throw new DefinitionCandidateError('FORBIDDEN', 'the registered base pack trust has been revoked')
      }
      if (registered.lifecycleState === 'deprecated' || registered.lifecycleState === 'retired') {
        throw new DefinitionCandidateError('VALIDATION_BLOCKED', `the registered base pack is ${registered.lifecycleState}`, {
          reasons: [`registry_lifecycle_${registered.lifecycleState}`],
        })
      }
    }
    let prior: DefinitionPredecessor
    try {
      prior = await resolvePinnedDefinition({
        definitions: this.#deps.definitions,
        ...(this.#deps.publishedPacks === undefined ? {} : { publishedPacks: this.#deps.publishedPacks }),
        basePack: pack,
      }, basePackRef, pack.manifest.namespace, scopeRef, ctx)
    } catch (error) {
      if (error instanceof DefinitionPredecessorError) {
        throw new DefinitionCandidateError('SCHEMA_NOT_FOUND', error.message, { cause: error })
      }
      throw error
    }
    // Dynamic publication is an authorised ledger without mandatory component registration.
    // A static catalogue seed alone cannot prove current registered availability.
    if (registered === undefined && prior.asset === undefined) {
      throw new DefinitionCandidateError('SCHEMA_NOT_FOUND', 'the pinned static base pack has no authorised registry entry')
    }
    if (prior.definition.namespace !== pack.manifest.namespace ||
        !sameRef(prior.definition.ref, pack.manifest.definitionsRef) ||
        prior.definition.scopeRef.tenantId !== scopeRef.tenantId || prior.definition.scopeRef.spaceId !== scopeRef.spaceId) {
      throw new DefinitionCandidateError('VERSION_CONFLICT', 'the base pack and published definition pins or scope disagree')
    }
    const definition = definitionRecordOf(prior.definition)
    // Key by logical id only. Identical names never merge distinct business declarations.
    const displayNames = Object.fromEntries(definition.objects.map((object) => [object.id, object.displayName]))
    return structuredClone({
      packRef: basePackRef,
      definition,
      objectLogicalIds: definition.objects.map((object) => object.id),
      attributeLogicalIds: definition.attributes.map((attribute) => attribute.id),
      relationLogicalIds: definition.relations.map((relation) => relation.id),
      attributes: definition.attributes.map((attribute) => ({
        logicalId: attribute.id,
        objectLogicalId: attribute.objectId,
        valueType: attribute.valueType,
        ...(attribute.unit === undefined ? {} : { unitCode: attribute.unit.unitCode, dimension: attribute.unit.dimension }),
      })),
      displayNames,
    })
  }
}

export function createDynamicDefinitionTerminologySource(
  dependencies: DynamicDefinitionTerminologyDependencies,
): DefinitionTerminologySource {
  return new DynamicDefinitionTerminologySource(dependencies)
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}
