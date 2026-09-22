import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * LOCAL-062 guard: the production PostgreSQL `SemanticDefinitionStore` must live in the
 * `control-postgres` adapter and be imported from there by the integration suites. The
 * old inline test helper must not reappear, and the adapter must stay free of
 * `application`/`semantic-engine` imports so the layer rule (adapters → contracts) holds.
 */
const helperPath = fileURLToPath(
  new URL('../integration/postgres-semantic-definition-store.ts', import.meta.url),
)
const adapterPath = fileURLToPath(
  new URL('../../packages/adapters/control-postgres/src/semantic-definition-store.ts', import.meta.url),
)
const adapterEntryPath = fileURLToPath(
  new URL('../../packages/adapters/control-postgres/src/index.ts', import.meta.url),
)
const specPaths = [
  fileURLToPath(new URL('../integration/semantic-definitions.spec.ts', import.meta.url)),
  fileURLToPath(new URL('../integration/home-energy-pack-postgres.spec.ts', import.meta.url)),
]

const ADAPTER_IMPORT = /import\s*\{[^}]*\bPostgresSemanticDefinitionStore\b[^}]*\}\s*from\s*'@ontology\/adapter-control-postgres'/s

describe('semantic definition store location', () => {
  it('no longer keeps an inline PostgreSQL store in the integration test helper', () => {
    expect(existsSync(helperPath)).toBe(false)
  })

  it('imports the adapter implementation from @ontology/adapter-control-postgres', () => {
    for (const specPath of specPaths) {
      const source = readFileSync(specPath, 'utf8')
      expect(source, specPath).toMatch(ADAPTER_IMPORT)
    }
  })

  it('exports the PostgreSQL store from the adapter entry point', () => {
    const entry = readFileSync(adapterEntryPath, 'utf8')
    expect(entry).toContain("export { PostgresSemanticDefinitionStore } from './semantic-definition-store'")
  })

  it('keeps the adapter implementation dependent on contracts and pg only', () => {
    const source = readFileSync(adapterPath, 'utf8')
    expect(source).toContain('agent_platform.semantic_definition_versions')
    expect(source).not.toContain('@ontology/semantic-engine')
    expect(source).not.toContain('@ontology/application')
  })
})
