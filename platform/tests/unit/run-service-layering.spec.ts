import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RUNS_DIR = fileURLToPath(new URL('../../packages/application/src/runs', import.meta.url))
const HTTP_SERVER = fileURLToPath(new URL('../../apps/api/src/http/server.ts', import.meta.url))
const PG_RUN_STORE = fileURLToPath(
  new URL('../../packages/adapters/control-postgres/src/run-store.ts', import.meta.url),
)

const FORBIDDEN_IN_APPLICATION = [
  /from 'fastify'/,
  /from 'express'/,
  /from 'koa'/,
  /from 'pg'/,
  /@ontology\/adapter-/,
  /@ontology\/app-/,
  /@ontology\/extension-/,
  /industry-packs/,
]

/**
 * The run service is the application layer: it receives the run store, the control ledger and
 * the profile binder by construction injection and must never import a framework, a database
 * driver or an adapter (SPEC §2 / INV-02). The HTTP framework lives in `apps/api`. These
 * scans make the boundary explicit in addition to the eslint rule and the architecture test.
 */
describe('run service layering', () => {
  it('keeps the application run sources free of framework, driver and adapter imports', () => {
    const files = readdirSync(RUNS_DIR).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(`${RUNS_DIR}/${file}`, 'utf8')
      for (const pattern of FORBIDDEN_IN_APPLICATION) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern)
      }
      if (file !== 'index.ts') {
        expect(source, `${file} must import the canonical contracts`).toMatch(/@ontology\/contracts/)
      }
    }
  })

  it('hosts the HTTP framework in the apps layer', () => {
    const server = readFileSync(HTTP_SERVER, 'utf8')
    expect(server).toMatch(/from 'fastify'/)
    expect(server).toMatch(/@ontology\/application/)
    expect(server).not.toMatch(/from 'pg'/)
  })

  it('keeps the PostgreSQL run store on the contracts + driver side of the boundary', () => {
    const store = readFileSync(PG_RUN_STORE, 'utf8')
    expect(store).toMatch(/from '@ontology\/contracts'/)
    expect(store).toMatch(/from 'pg'/)
    expect(store).not.toMatch(/@ontology\/application/)
  })
})
