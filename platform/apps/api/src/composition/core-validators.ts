import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject, ValidateFunction } from 'ajv'
import {
  createDynamicDefinitionTerminologySource,
  InMemoryIndustryPackCatalogue,
  StoreBackedIndustryPackCatalogue,
} from '@ontology/application'
import type {
  DefinitionTerminologySource,
  ManifestValidator,
  ProfileSpecValidator,
  TaskParameterValidator,
} from '@ontology/application'
import type { PostgresComponentRegistryStore, PostgresPublishedPackAssetStore, PostgresSemanticDefinitionStore } from '@ontology/adapter-control-postgres'
import { SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type { ToolSchemaValidator } from '@ontology/tool-services'
import { CONTRACT_SCHEMA_BASE } from './core-constants'
import { componentRef } from './core-component-ref'
import type { CoreExampleScenario } from './core-example-loader'

/** The Ajv-backed boundary validators the composition injects into catalogues, profiles and tools. */

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
  addFormats(ajv)
  for (const document of SCHEMA_DOCUMENTS) ajv.addSchema(document as SchemaObject)
  return ajv
}

export function taskParameterValidator(ajv: Ajv2020): TaskParameterValidator {
  return {
    validate(schema, value) {
      const validate = ajv.compile(schema as SchemaObject)
      return validate(value)
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: (validate.errors ?? []).map(
              (error) => `${error.instancePath === '' ? '$' : error.instancePath} ${error.message ?? 'is invalid'}`,
            ),
          }
    },
  }
}

export function profileValidator(ajv: Ajv2020): ProfileSpecValidator {
  const validate = ajv.getSchema(`${CONTRACT_SCHEMA_BASE}/industry.schema.json#/$defs/ProfileSpec`)
  if (validate === undefined) throw new Error('the canonical ProfileSpec schema is unavailable')
  return (spec: unknown) => validate(spec)
    ? { valid: true, issues: [] }
    : {
        valid: false,
        issues: (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath === '' ? '$' : error.instancePath,
          message: error.message ?? 'invalid',
        })),
      }
}

export function manifestValidator(ajv: Ajv2020): ManifestValidator {
  const validate = ajv.getSchema(`${CONTRACT_SCHEMA_BASE}/component.schema.json#/$defs/ComponentManifest`)
  if (validate === undefined) throw new Error('the canonical ComponentManifest schema is unavailable')
  return (manifest: unknown) => validate(manifest)
    ? { valid: true, issues: [] }
    : {
        valid: false,
        issues: (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath === '' ? '$' : error.instancePath,
          message: error.message ?? 'invalid',
        })),
      }
}

/** Project the mounted industry packs into the professional terminology a workspace may build on. */
export function terminologySourceFor(
  scenarios: readonly CoreExampleScenario[],
  publishedPacks: PostgresPublishedPackAssetStore,
  definitions: PostgresSemanticDefinitionStore,
  registry: PostgresComponentRegistryStore,
): DefinitionTerminologySource {
  const staticCatalogue = new InMemoryIndustryPackCatalogue()
  for (const scenario of scenarios) staticCatalogue.registerPack({
    // Preserve the same pin registered into the component registry and mounted profiles.
    ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    manifest: scenario.industryManifest,
    testSuite: scenario.testSuite,
  })
  return createDynamicDefinitionTerminologySource({
    catalogue: new StoreBackedIndustryPackCatalogue({ store: publishedPacks, fallback: staticCatalogue }),
    definitions,
    registry,
    publishedPacks,
  })
}

export function toolSchemaValidator(ajv: Ajv2020): ToolSchemaValidator {
  const byRef = new Map<string, ValidateFunction>()
  return {
    validateRef(ref, value) {
      let validate = byRef.get(ref)
      if (validate === undefined) {
        validate = ajv.getSchema(ref)
        if (validate === undefined) throw new Error(`unknown canonical tool schema ref: ${ref}`)
        byRef.set(ref, validate)
      }
      return validate(value)
        ? { valid: true, issues: [] }
        : { valid: false, issues: (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) }
    },
    validateInline(schema, value) {
      const validate = ajv.compile(schema as SchemaObject)
      return validate(value)
        ? { valid: true, issues: [] }
        : { valid: false, issues: (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) }
    },
  }
}
