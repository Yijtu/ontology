import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const INTEGRATION_SPEC = fileURLToPath(
  new URL('../integration/component-registry.spec.ts', import.meta.url),
)
const ADAPTER_IMPLEMENTATION = fileURLToPath(
  new URL('../../packages/adapters/control-postgres/src/component-registry-store.ts', import.meta.url),
)

/**
 * LOCAL-057 moved the real PostgreSQL registry store out of the test file and into the
 * control-postgres adapter. These scans keep the production path from silently regressing
 * back into an inline test-only copy, and keep the adapter on the contracts-only side of
 * the SPEC §2 dependency direction.
 */
describe('component registry store layering', () => {
  it('no longer keeps an inline pg store implementation in the integration spec', () => {
    const spec = readFileSync(INTEGRATION_SPEC, 'utf8')

    expect(spec).toContain('PostgresComponentRegistryStore')
    expect(spec).toMatch(/from '@ontology\/adapter-control-postgres'/)
    expect(spec).not.toMatch(/class\s+PostgresComponentRegistryStore/)
    expect(spec).not.toMatch(/implements\s+ComponentRegistryStore/)
    expect(spec).not.toMatch(/private\s+#insertEvent|#withScope/)
  })

  it('adapter implementation depends on contracts and pg, never on application', () => {
    const adapter = readFileSync(ADAPTER_IMPLEMENTATION, 'utf8')

    expect(adapter).toMatch(/from '@ontology\/contracts'/)
    expect(adapter).toMatch(/from 'pg'/)
    expect(adapter).not.toMatch(/@ontology\/application/)
  })
})
