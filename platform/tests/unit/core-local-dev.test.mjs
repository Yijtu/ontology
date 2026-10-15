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

test('keeps both external-model integrations off by default and never forwards their secrets to Vite', () => {
  const companySecret = 'local-only-company-secret'
  const jevSecret = 'local-only-jev-secret'
  const disabled = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_API_KEY: companySecret,
    CORE_JEV_SECRET_REF: 'env:CORE_JEV_API_KEY',
    CORE_JEV_API_KEY: jevSecret,
    ONTOLOGY_COMPANY_MODEL_API_KEY: 'legacy-company-secret',
    ONTOLOGY_JEV_API_KEY: 'legacy-jev-secret',
    VITE_MASQUERADE_API_KEY: 'must-not-reach-browser',
  })

  assert.equal(disabled.apiEnvironment.CORE_ENABLE_MODELS, 'false')
  assert.equal(disabled.apiEnvironment.CORE_ENABLE_JEV, 'false')
  assert.equal(disabled.apiEnvironment.CORE_COMPANY_MODEL_API_KEY, undefined)
  assert.equal(disabled.apiEnvironment.CORE_JEV_API_KEY, undefined)
  assert.equal(disabled.apiEnvironment.ONTOLOGY_COMPANY_MODEL_API_KEY, undefined)
  assert.equal(disabled.apiEnvironment.ONTOLOGY_JEV_API_KEY, undefined)
  assert.equal(disabled.apiEnvironment.VITE_MASQUERADE_API_KEY, undefined)
  assert.equal(disabled.webEnvironment.VITE_MASQUERADE_API_KEY, undefined)
})

test('keeps the actual business writer and read-only database URLs on the API side only', () => {
  const writer = 'postgresql://business_writer:synthetic-writer@127.0.0.1:54331/business'
  const reader = 'postgresql://business_reader:synthetic-reader@127.0.0.1:54331/business'
  const config = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    PROJECT_BUSINESS_DATABASE_URL: writer,
    PROJECT_BUSINESS_READONLY_DATABASE_URL: reader,
  })
  assert.equal(config.apiEnvironment.PROJECT_BUSINESS_DATABASE_URL, writer)
  assert.equal(config.apiEnvironment.PROJECT_BUSINESS_READONLY_DATABASE_URL, reader)
  assert.equal(config.webEnvironment.PROJECT_BUSINESS_DATABASE_URL, undefined)
  assert.equal(config.webEnvironment.PROJECT_BUSINESS_READONLY_DATABASE_URL, undefined)
})

test('company generation-only forwards only its configured API-side secret', () => {
  const companySecret = 'local-only-company-secret'
  const jevSecret = 'local-only-jev-secret'
  const enabled = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    CORE_ENABLE_MODELS: 'true',
    CORE_COMPANY_MODEL_BASE_URL: 'https://company.example',
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_PLATFORM_ID: 'company-model',
    CORE_COMPANY_MODEL_VENDOR_MODEL: 'vendor-model',
    CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
    CORE_COMPANY_MODEL_API_KEY: companySecret,
    CORE_JEV_BASE_URL: 'https://jev.example',
    CORE_JEV_SECRET_REF: 'env:CORE_JEV_API_KEY',
    CORE_JEV_API_KEY: jevSecret,
    OTHER_SERVICE_API_KEY: 'unreferenced-secret',
    VITE_MASQUERADE_API_KEY: 'must-not-reach-browser',
    VITE_UNSAFE_EXTRA: 'never-forward-client-prefixed-vars',
  })
  assert.equal(enabled.apiEnvironment.CORE_ENABLE_MODELS, 'true')
  assert.equal(enabled.apiEnvironment.CORE_ENABLE_JEV, 'false')
  assert.equal(enabled.apiEnvironment.CORE_COMPANY_MODEL_API_KEY, companySecret)
  assert.equal(enabled.apiEnvironment.CORE_COMPANY_MODEL_PLATFORM_ID, 'company-model')
  assert.equal(enabled.apiEnvironment.CORE_JEV_BASE_URL, undefined)
  assert.equal(enabled.apiEnvironment.CORE_JEV_API_KEY, undefined)
  assert.equal(enabled.apiEnvironment.OTHER_SERVICE_API_KEY, undefined)
  assert.equal(enabled.webEnvironment.CORE_COMPANY_MODEL_API_KEY, undefined)
  assert.equal(enabled.webEnvironment.CORE_ENABLE_MODELS, undefined)
  assert.deepEqual(
    Object.keys(enabled.webEnvironment).filter((key) => key.startsWith('VITE_')).sort(),
    ['VITE_API_BASE_URL', 'VITE_CORE_API_PORT'],
  )
})

test('JEV-only forwards only its configured API-side secret without enabling company generation', () => {
  const companySecret = 'local-only-company-secret'
  const jevSecret = 'local-only-jev-secret'
  const enabled = resolveCoreDevEnvironment({ CORE_DATABASE_URL: appUrl }, {
    CORE_ENABLE_JEV: 'true',
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_API_KEY: companySecret,
    CORE_JEV_BASE_URL: 'https://jev.example',
    CORE_JEV_SECRET_REF: 'env:CORE_JEV_API_KEY',
    CORE_JEV_PLATFORM_MODEL_ID: 'jev-model',
    CORE_JEV_VENDOR_MODEL: 'jev-vendor-model',
    CORE_JEV_API_KEY: jevSecret,
  })
  assert.equal(enabled.apiEnvironment.CORE_ENABLE_MODELS, 'false')
  assert.equal(enabled.apiEnvironment.CORE_ENABLE_JEV, 'true')
  assert.equal(enabled.apiEnvironment.CORE_COMPANY_MODEL_API_KEY, undefined)
  assert.equal(enabled.apiEnvironment.CORE_COMPANY_MODEL_SECRET_REF, undefined)
  assert.equal(enabled.apiEnvironment.CORE_JEV_API_KEY, jevSecret)
  assert.equal(enabled.apiEnvironment.CORE_JEV_PLATFORM_MODEL_ID, 'jev-model')
  assert.equal(enabled.webEnvironment.CORE_JEV_API_KEY, undefined)
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
