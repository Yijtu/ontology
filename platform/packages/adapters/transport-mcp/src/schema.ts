import { SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type { JsonSchemaObject } from '@ontology/contracts'
import { McpTransportError } from './errors'

const DEFS_PREFIX = '#/$defs/'

/**
 * Every canonical schema document shares one `$defs` namespace (the generator asserts
 * the 251 definition names are globally unique), so a `$ref` can be resolved by its
 * definition name regardless of which document declared it.
 */
function collectDefinitions(): ReadonlyMap<string, JsonSchemaObject> {
  const definitions = new Map<string, JsonSchemaObject>()
  for (const document of SCHEMA_DOCUMENTS) {
    const defs = document['$defs']
    if (typeof defs !== 'object' || defs === null || Array.isArray(defs)) continue
    for (const [name, schema] of Object.entries(defs)) {
      if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
        definitions.set(name, schema as JsonSchemaObject)
      }
    }
  }
  return definitions
}

const DEFINITIONS = collectDefinitions()

function definitionNameOf(ref: string): string | undefined {
  const index = ref.indexOf(DEFS_PREFIX)
  if (index < 0) return undefined
  const name = ref.slice(index + DEFS_PREFIX.length)
  return name.length === 0 ? undefined : name
}

function rewriteRefs(node: unknown, referenced: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((entry) => rewriteRefs(entry, referenced))
  if (node === null || typeof node !== 'object') return node
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = definitionNameOf(value)
      if (name === undefined) {
        throw new McpTransportError(
          'INVALID_SCHEMA',
          `the schema reference ${value} is not a canonical $defs pointer`,
        )
      }
      referenced.add(name)
      result.$ref = `${DEFS_PREFIX}${name}`
      continue
    }
    result[key] = rewriteRefs(value, referenced)
  }
  return result
}

/**
 * Resolve a canonical `$ref` (e.g. `tools.schema.json#/$defs/DataQueryInput`) into a
 * self-contained JSON Schema with local `#/$defs/...` references.
 *
 * The MCP `tools/list` wire format requires each tool's `inputSchema`/`outputSchema` to
 * be a concrete JSON Schema object with `type: "object"`; an unresolvable
 * `https://ontology.local/...` reference would not be usable by an external MCP client.
 * The closure of transitively referenced definitions is inlined, so the emitted schema
 * needs no network resolution.
 */
export function resolveSchemaRef(ref: string): JsonSchemaObject {
  const name = definitionNameOf(ref)
  if (name === undefined) {
    throw new McpTransportError(
      'INVALID_SCHEMA',
      `the schema reference ${ref} is not a canonical $defs pointer`,
    )
  }
  const target = DEFINITIONS.get(name)
  if (target === undefined) {
    throw new McpTransportError('INVALID_SCHEMA', `no canonical definition is registered as ${name}`)
  }

  const rootReferenced = new Set<string>()
  const root = rewriteRefs(target, rootReferenced) as JsonSchemaObject
  const defs: Record<string, unknown> = {}
  const queue = [...rootReferenced]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || Object.hasOwn(defs, current)) continue
    const schema = DEFINITIONS.get(current)
    if (schema === undefined) {
      throw new McpTransportError('INVALID_SCHEMA', `no canonical definition is registered as ${current}`)
    }
    const nested = new Set<string>()
    defs[current] = rewriteRefs(schema, nested)
    for (const next of nested) {
      if (!Object.hasOwn(defs, next)) queue.push(next)
    }
  }

  // `type: "object"` is required by the MCP tool schema; a union target has no top-level
  // type of its own, so it is added here without overriding a concrete target type.
  return { type: 'object', ...root, $defs: defs }
}
