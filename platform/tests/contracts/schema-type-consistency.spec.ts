import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import {
  CONTRACT_VERSION,
  SCHEMA_DOCUMENTS,
  SCHEMA_DOCUMENT_BY_ID,
  TOOL_CATALOGUE,
  type OntologyContracts,
} from '@ontology/contracts'
import { contractsRoot, platformRoot, readSchemaDocument, schemaFiles, createAjv, validatorForRef } from './helpers'

describe('canonical JSON Schema <-> generated TypeScript', () => {
  it('fails when the committed generated output drifts from schema/', () => {
    const script = join(contractsRoot, 'scripts', 'generate-contracts.mjs')
    const output = execFileSync(process.execPath, [script, '--check'], {
      cwd: platformRoot,
      encoding: 'utf8',
    })
    expect(output).toContain('match the canonical JSON Schema')
  })

  it('emits a TypeScript declaration for every $defs entry in every schema document', () => {
    const generated = readFileSync(join(contractsRoot, 'src', 'generated', 'contracts.ts'), 'utf8')
    const defNames = schemaFiles().flatMap((file) =>
      Object.keys(readSchemaDocument(file).$defs ?? {}),
    )
    expect(defNames.length).toBeGreaterThan(100)

    const missing = defNames.filter(
      (name) => !new RegExp(`export (type|interface) ${name}\\b`).test(generated),
    )
    expect(missing).toEqual([])
  })

  it('pins the contract version in the generated bundle and the generated type', () => {
    expect(CONTRACT_VERSION).toBe('0.2.0')
    expectTypeOf<OntologyContracts['contractVersion']>().toEqualTypeOf<'0.2.0'>()
  })

  it('exports every canonical schema document keyed by its $id', () => {
    expect(SCHEMA_DOCUMENTS).toHaveLength(schemaFiles().length)
    for (const file of schemaFiles()) {
      const doc = readSchemaDocument(file)
      expect(doc.$id, `${file} declares $id`).toBeTypeOf('string')
      expect(SCHEMA_DOCUMENT_BY_ID[String(doc.$id)]).toEqual(doc)
    }
  })

  it('resolves every tool catalogue input/output schema reference', () => {
    const ajv = createAjv()
    for (const tool of TOOL_CATALOGUE) {
      expect(() => validatorForRef(ajv, String(tool.inputSchema.$ref)), tool.toolId).not.toThrow()
      expect(() => validatorForRef(ajv, String(tool.outputSchema.$ref)), tool.toolId).not.toThrow()
    }
  })

  it('resolves tool catalogue references from the generated schema bundle alone', () => {
    // This is the downstream consumption path: a tool-services package registers the
    // exported SCHEMA_DOCUMENTS with ajv and compiles the catalogue refs.
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
    addFormats(ajv)
    for (const document of SCHEMA_DOCUMENTS) {
      ajv.addSchema(document as SchemaObject)
    }
    for (const tool of TOOL_CATALOGUE) {
      expect(() => validatorForRef(ajv, String(tool.inputSchema.$ref)), tool.toolId).not.toThrow()
    }
  })

  it('uses draft 2020-12 for every canonical schema document', () => {
    for (const file of schemaFiles()) {
      expect(readSchemaDocument(file).$schema, file).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      )
    }
  })

  // ResolvedProfile/ResolvedCapability repeat their base properties instead of using
  // allOf, because allOf plus additionalProperties:false would reject the extension.
  // These assertions keep the duplicated property sets from silently drifting apart.
  it('keeps ResolvedProfile in sync with ProfileSpec', () => {
    const defs = readSchemaDocument('industry.schema.json').$defs ?? {}
    const propertiesOf = (name: string): string[] =>
      Object.keys((defs[name] as { properties: Record<string, unknown> }).properties)

    const base = new Set(propertiesOf('ProfileSpec'))
    const resolved = new Set(propertiesOf('ResolvedProfile'))

    for (const key of base) {
      expect(resolved.has(key), `ResolvedProfile is missing ProfileSpec.${key}`).toBe(true)
    }
    expect([...resolved].filter((key) => !base.has(key)).sort()).toEqual([
      'explicitDegradations',
      'resolvedAt',
      'resolvedCapabilities',
      'resolvedVersions',
      'snapshotHash',
    ])
  })

  it('keeps ResolvedCapability in sync with Capability', () => {
    const propertiesOf = (file: string, name: string): string[] => {
      const defs = readSchemaDocument(file).$defs ?? {}
      return Object.keys((defs[name] as { properties: Record<string, unknown> }).properties)
    }

    const base = new Set(propertiesOf('component.schema.json', 'Capability'))
    const resolved = new Set(propertiesOf('industry.schema.json', 'ResolvedCapability'))

    for (const key of base) {
      expect(resolved.has(key), `ResolvedCapability is missing Capability.${key}`).toBe(true)
    }
    expect([...resolved].filter((key) => !base.has(key))).toEqual(['sourceComponentRef'])
  })
})
