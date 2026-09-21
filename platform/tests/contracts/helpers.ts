import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject, ValidateFunction } from 'ajv'
import { expect } from 'vitest'

export const SCHEMA_BASE = 'https://ontology.local/schema'
export const platformRoot = fileURLToPath(new URL('../..', import.meta.url))
export const contractsRoot = join(platformRoot, 'packages', 'contracts')
export const schemaDir = join(contractsRoot, 'schema')

export type JsonSchemaDocument = Record<string, unknown> & { $id?: string; $defs?: Record<string, unknown> }

export function schemaFiles(): string[] {
  return readdirSync(schemaDir)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
}

export function readSchemaDocument(file: string): JsonSchemaDocument {
  return JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as JsonSchemaDocument
}

export function readSchemaData(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as Record<string, unknown>
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(platformRoot, 'tests', 'contracts', 'fixtures', name), 'utf8'))
}

/**
 * Every canonical schema document is registered by its `$id`, so `$ref`s between
 * documents (e.g. tools -> data -> common) resolve exactly as a consumer would see them.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: true,
  })
  addFormats(ajv)
  for (const file of schemaFiles()) {
    ajv.addSchema(readSchemaDocument(file) as SchemaObject)
  }
  return ajv
}

export function validator(ajv: Ajv2020, file: string, defName: string): ValidateFunction {
  const id = `${SCHEMA_BASE}/${file}#/$defs/${defName}`
  const validate = ajv.getSchema(id)
  if (validate === undefined) throw new Error(`no validator registered for ${id}`)
  return validate
}

export function validatorForRef(ajv: Ajv2020, ref: string): ValidateFunction {
  const validate = ajv.getSchema(ref)
  if (validate === undefined) throw new Error(`no validator registered for ${ref}`)
  return validate
}

export function describeErrors(validate: ValidateFunction): string {
  return JSON.stringify(validate.errors ?? [], null, 2)
}

export function expectValid(validate: ValidateFunction, value: unknown, label: string): void {
  expect(validate(value), `${label}\n${describeErrors(validate)}`).toBe(true)
}

export function expectInvalid(validate: ValidateFunction, value: unknown, label: string): void {
  expect(validate(value), `${label} unexpectedly passed validation`).toBe(false)
}

/** Deep clone through the wire so a test can prove nothing was silently coerced. */
export function wireRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function collectPropertyNames(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const entry of schema) collectPropertyNames(entry, out)
    return out
  }
  if (schema === null || typeof schema !== 'object') return out

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const name of Object.keys(value)) out.add(name)
    }
    collectPropertyNames(value, out)
  }
  return out
}

export function collectRefs(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const entry of schema) collectRefs(entry, out)
    return out
  }
  if (schema === null || typeof schema !== 'object') return out

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') out.push(value)
    else collectRefs(value, out)
  }
  return out
}
