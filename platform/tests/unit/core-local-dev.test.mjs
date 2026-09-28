import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  assertLoopbackPortAvailable,
  parseEnvFileText,
  requireCoreApiEntry,
  resolveCoreDevEnvironment,
} from '../../scripts/dev-core.mjs'

const appPassword = 'local-app-password-0123456789'
const appUrl = `postgresql://ontology_app:${appPassword}@127.0.0.1:54330/ontology_core`

test('loads local config with explicit environment precedence and never falls back to generic DATABASE_URL', () => {
  const file = parseEnvFileText([
    '# local generated configuration',
    `CORE_DATABASE_URL=${appUrl}`,
    'CORE_API_PORT=3001',
    'CORE_WEB_PORT=5174',
    'CORE_PG_PORT=54330',
    'CORE_ENABLE_MODELS=false',
    'VITE_API_BASE_URL=',
  ].join('\n'))
  const config = resolveCoreDevEnvironment(file, { CORE_WEB_PORT: '5175', DATABASE_URL: 'postgresql://admin@127.0.0.1:54329/old' })

  assert.equal(config.webPort, 5175)
  assert.equal(config.apiEnvironment.CORE_ENABLE_MODELS, 'false')
  assert.throws(
    () => resolveCoreDevEnvironment({}, { DATABASE_URL: 'postgresql://admin@127.0.0.1:54329/old' }),
    /CORE_DATABASE_URL is required/u,
  )
})

test('defaults external models off and passes explicitly enabled model secrets only to API', () => {
  const secret = 'local-only-model-secret'
  const disabled = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    ONTOLOGY_COMPANY_MODEL_API_KEY: secret,
    VITE_MASQUERADE_API_KEY: 'must-not-reach-browser',
  })
  assert.equal(disabled.apiEnvironment.CORE_ENABLE_MODELS, 'false')
  assert.equal(disabled.apiEnvironment.ONTOLOGY_COMPANY_MODEL_API_KEY, undefined)
  assert.equal(disabled.apiEnvironment.VITE_MASQUERADE_API_KEY, undefined)
  assert.equal(disabled.webEnvironment.VITE_MASQUERADE_API_KEY, undefined)

  const enabled = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    CORE_ENABLE_MODELS: 'true',
    ONTOLOGY_COMPANY_MODEL_API_KEY: secret,
    VITE_MASQUERADE_API_KEY: 'must-not-reach-browser',
    VITE_UNSAFE_EXTRA: 'never-forward-client-prefixed-vars',
  })
  assert.equal(enabled.apiEnvironment.ONTOLOGY_COMPANY_MODEL_API_KEY, secret)
  assert.equal(enabled.apiEnvironment.VITE_MASQUERADE_API_KEY, undefined)
  assert.equal(enabled.webEnvironment.ONTOLOGY_COMPANY_MODEL_API_KEY, undefined)
  assert.deepEqual(
    Object.keys(enabled.webEnvironment).filter((key) => key.startsWith('VITE_')).sort(),
    ['VITE_API_BASE_URL', 'VITE_CORE_API_PORT'],
  )
})

test('the API entry check fails explicitly before services start when core-main is absent', async () => {
  await assert.rejects(
    requireCoreApiEntry(resolve(tmpdir(), 'core-main-intentionally-missing.ts')),
    /Core API entry is not implemented yet.*No services were started/u,
  )
})

test('port preflight detects another listener and releases only its own probe socket', async () => {
  const occupied = createServer()
  await new Promise((resolveListen, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', resolveListen)
  })
  const address = occupied.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP loopback address')
  await assert.rejects(assertLoopbackPortAvailable(address.port, 'Core API'), /already occupied/u)
  await new Promise((resolveClose, reject) => occupied.close((error) => error === undefined ? resolveClose() : reject(error)))
  await assertLoopbackPortAvailable(address.port, 'Core API')
})
