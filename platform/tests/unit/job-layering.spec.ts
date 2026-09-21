import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const JOBS_DIR = fileURLToPath(new URL('../../packages/application/src/jobs', import.meta.url))
const HTTP_JOBS = fileURLToPath(new URL('../../apps/api/src/http/jobs.ts', import.meta.url))
const PG_JOB_STORE = fileURLToPath(
  new URL('../../packages/adapters/control-postgres/src/job-store.ts', import.meta.url),
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
 * The job service and worker are the application layer: they receive the job store, the stage
 * handlers and the background quota by construction injection and must never import a
 * framework, a database driver or an adapter (SPEC §2 / INV-02). The HTTP framework lives in
 * `apps/api` and the worker process in `apps/worker`.
 */
describe('job service layering', () => {
  it('keeps the application job sources free of framework, driver and adapter imports', () => {
    const files = readdirSync(JOBS_DIR).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(`${JOBS_DIR}/${file}`, 'utf8')
      for (const pattern of FORBIDDEN_IN_APPLICATION) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern)
      }
      if (file !== 'index.ts') {
        expect(source, `${file} must import the canonical contracts`).toMatch(/@ontology\/contracts/)
      }
    }
  })

  it('hosts the job HTTP routes in the apps layer on the shared server', () => {
    const source = readFileSync(HTTP_JOBS, 'utf8')
    expect(source).toMatch(/@ontology\/application/)
    expect(source).not.toMatch(/from 'pg'/)
    expect(source).not.toMatch(/Fastify\(/)
  })

  it('keeps the PostgreSQL job store on the contracts + driver side of the boundary', () => {
    const store = readFileSync(PG_JOB_STORE, 'utf8')
    expect(store).toMatch(/from '@ontology\/contracts'/)
    expect(store).toMatch(/from 'pg'/)
    expect(store).not.toMatch(/@ontology\/application/)
  })
})
