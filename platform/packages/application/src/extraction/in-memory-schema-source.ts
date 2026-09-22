import { isToolContext } from '@ontology/contracts'
import type { IndustrySchema, IndustrySchemaSource, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { refKey } from '../profiles/canonical'

/**
 * Reference `IndustrySchemaSource` for unit tests and local composition. The composition
 * root preloads published definition versions by their exact reference; a missing reference
 * resolves to `undefined` so the pipeline fails explicitly instead of inventing a schema.
 */
export class InMemoryIndustrySchemaSource implements IndustrySchemaSource {
  readonly #schemas = new Map<string, IndustrySchema>()

  constructor(entries?: readonly { readonly ref: VersionRef; readonly schema: IndustrySchema }[]) {
    for (const entry of entries ?? []) {
      this.#schemas.set(refKey(entry.ref), entry.schema)
    }
  }

  register(ref: VersionRef, schema: IndustrySchema): void {
    this.#schemas.set(refKey(ref), schema)
  }

  async getSchema(
    _scopeRef: ScopeRef,
    definitionRef: VersionRef,
    ctx: ToolContext,
  ): Promise<IndustrySchema | undefined> {
    if (!isToolContext(ctx)) {
      throw new Error('a host-minted trusted tool context is required to resolve an industry schema')
    }
    const schema = this.#schemas.get(refKey(definitionRef))
    return schema === undefined ? undefined : structuredClone(schema)
  }
}
