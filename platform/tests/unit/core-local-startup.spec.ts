import { describe, expect, it } from 'vitest'
import {
  resolveCorePreparationOptions,
  serializeCoreLocalEnvironment,
} from '../../scripts/prepare-core-db'

const ADMIN_URL = 'postgresql://postgres:admin-only-test-password@127.0.0.1:54330/ontology_core'
const APP_PASSWORD = 'local-app-password-0123456789'

describe('local core DB preparation config', () => {
  it('derives an ontology_app URL and writes only app-local config', () => {
    const options = resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: ADMIN_URL,
      CORE_APP_PASSWORD: APP_PASSWORD,
    })
    const appUrl = new URL(options.appDatabaseUrl)
    const file = serializeCoreLocalEnvironment(options)

    expect(appUrl.username).toBe('ontology_app')
    expect(appUrl.password).toBe(APP_PASSWORD)
    expect(appUrl.pathname).toBe('/ontology_core')
    expect(options.apiPort).toBe(3001)
    expect(options.webPort).toBe(5174)
    expect(options.pgPort).toBe(54330)
    expect(file).toContain(`CORE_DATABASE_URL=${options.appDatabaseUrl}`)
    expect(file).toContain(`CORE_APP_PASSWORD=${APP_PASSWORD}`)
    expect(file).toContain('CORE_TENANT_ID=11111111-1111-4111-8111-111111111111')
    expect(file).toContain('CORE_SPACE_ID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(file).toContain('CORE_ENABLE_MODELS=false')
    expect(file).not.toContain('CORE_CONTROL_DATABASE_URL')
    expect(file).not.toContain('CORE_POSTGRES_PASSWORD')
    expect(file).not.toContain('admin-only-test-password')
  })

  it('refuses the old PostgreSQL port, a remote target, and a non-core database', () => {
    expect(() => resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:54329/ontology_core',
      CORE_PG_PORT: '54329',
    })).toThrow(/existing 3000\/5173\/54329/u)
    expect(() => resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: 'postgresql://postgres:pw@db.example:54330/ontology_core',
    })).toThrow(/loopback/u)
    expect(() => resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:54330/postgres',
    })).toThrow(/ontology_core/u)
  })

  it('keeps app and server ports separate', () => {
    expect(() => resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: ADMIN_URL,
      CORE_API_PORT: '54330',
    })).toThrow(/must be distinct/u)
    expect(() => resolveCorePreparationOptions({
      CORE_CONTROL_DATABASE_URL: ADMIN_URL,
      CORE_WEB_PORT: '5173',
    })).toThrow(/existing 3000\/5173\/54329/u)
  })
})
