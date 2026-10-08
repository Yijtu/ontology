import type {
  IndustryAttributeValueType,
  SemanticDefinitionRecord,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { DefinitionCandidateError } from './errors'

/**
 * The professional terminology a workspace may build on: the object/attribute/relation logical
 * ids already declared by the mounted industry pack (or by the workspace's own pinned base
 * version). SPEC v0.3a §3.1: 专业术语来自挂载资产 — a generated candidate may extend the mounted
 * vocabulary, but its references resolve against these terms and its display name is taken
 * from the mounted asset when the logical id already exists.
 *
 * This is a read-only projection, not the published definition model: the application layer
 * consumes it without importing the semantic-engine service package.
 */
export interface MountedAttributeTerm {
  readonly logicalId: string
  readonly objectLogicalId: string
  readonly valueType: IndustryAttributeValueType
  readonly unitCode?: string
  readonly dimension?: string
}

export interface MountedDefinitionTerminology {
  readonly objectLogicalIds: readonly string[]
  readonly attributeLogicalIds: readonly string[]
  readonly relationLogicalIds: readonly string[]
  readonly attributes: readonly MountedAttributeTerm[]
  /** Display name per known logical id (object/attribute/relation), when the asset declares one. */
  readonly displayNames: Readonly<Record<string, string>>
  /** Exact published declarations, including identity, units and versioned provenance. */
  readonly definition?: SemanticDefinitionRecord
  readonly packRef?: VersionRef
}

export const EMPTY_TERMINOLOGY: MountedDefinitionTerminology = {
  objectLogicalIds: [],
  attributeLogicalIds: [],
  relationLogicalIds: [],
  attributes: [],
  displayNames: {},
}

/**
 * Resolves the mounted terminology for a workspace's pinned base pack/definition. Returning
 * `undefined` (or `EMPTY_TERMINOLOGY`) is permitted only without a pin, for bootstrap modelling
 * from SPEC §5.3. A supplied pin that cannot be read must fail explicitly.
 */
export interface DefinitionTerminologySource {
  getTerminology(
    scopeRef: ScopeRef,
    definitionRef: VersionRef | undefined,
    ctx: ToolContext,
  ): Promise<MountedDefinitionTerminology | undefined>
}

/**
 * A fixed terminology source for tests, local composition and a workspace with no mounted
 * package. It never invents terms.
 */
export class StaticDefinitionTerminologySource implements DefinitionTerminologySource {
  readonly #byRef = new Map<string, MountedDefinitionTerminology>()
  readonly #fallback: MountedDefinitionTerminology | undefined

  constructor(
    entries: readonly { readonly definitionRef: VersionRef; readonly terminology: MountedDefinitionTerminology }[] = [],
    fallback?: MountedDefinitionTerminology,
  ) {
    for (const entry of entries) this.#byRef.set(terminologyRefKey(entry.definitionRef), structuredClone(entry.terminology))
    this.#fallback = fallback
  }

  async getTerminology(
    _scopeRef: ScopeRef,
    definitionRef: VersionRef | undefined,
    _ctx: ToolContext,
  ): Promise<MountedDefinitionTerminology | undefined> {
    void _scopeRef
    void _ctx
    if (definitionRef === undefined) return this.#fallback
    const terminology = this.#byRef.get(terminologyRefKey(definitionRef))
    if (terminology === undefined) {
      throw new DefinitionCandidateError('SCHEMA_NOT_FOUND', 'the exact mounted terminology pin is unavailable')
    }
    return structuredClone(terminology)
  }
}

function terminologyRefKey(ref: VersionRef): string {
  return JSON.stringify([ref.id, ref.version, ref.digest])
}
