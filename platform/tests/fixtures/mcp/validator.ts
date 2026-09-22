import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import type { McpSchemaValidator } from '@ontology/adapter-transport-mcp'

/**
 * The MCP boundary validator used by the transport tests.
 *
 * The adapter validates remote `structuredContent` against the canonical `ToolResult`
 * schema through an injected port; this Ajv-backed implementation is the composition
 * root's stand-in, mirroring `tests/contracts/helpers.ts`.
 */
export function createMcpSchemaValidator(): McpSchemaValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
  addFormats(ajv)
  const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>()
  return {
    validateInline: (schema, value) => {
      let validate = compiled.get(schema)
      if (validate === undefined) {
        validate = ajv.compile(schema as SchemaObject)
        compiled.set(schema, validate)
      }
      if (validate(value)) return { valid: true, issues: [] }
      return {
        valid: false,
        issues: (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath,
          reason: error.message ?? 'invalid',
        })),
      }
    },
  }
}
