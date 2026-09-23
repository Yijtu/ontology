import { describe, expect, it, afterEach } from 'vitest'
import { SecretValue } from '@ontology/contracts'
import {
  SecretResolutionError,
  createEnvSecretResolver,
  envVarNameOf,
} from '@ontology/app-api'
import { toolContext } from './component-registry-fixtures'

/**
 * The resolver must satisfy the existing `SecretResolver` port and never surface a
 * resolved value. Every value used here is an obviously fake test literal, never a real
 * credential.
 */

const FAKE_VALUE = 'sk-fake-company-model-DO-NOT-LEAK-9f3c'
const FAKE_NAME = 'ONTOLOGY_COMPANY_MODEL_API_KEY'
const ctx = toolContext()

afterEach(() => {
  delete process.env[FAKE_NAME]
})

describe('envVarNameOf', () => {
  it('accepts every documented opaque ref form and returns the variable name', () => {
    expect(envVarNameOf(`env:${FAKE_NAME}`)).toBe(FAKE_NAME)
    expect(envVarNameOf(`env://${FAKE_NAME}`)).toBe(FAKE_NAME)
    expect(envVarNameOf(`secret://env/${FAKE_NAME}`)).toBe(FAKE_NAME)
    expect(envVarNameOf(FAKE_NAME)).toBe(FAKE_NAME)
  })

  it('rejects a ref that is not a variable name without echoing the rejected text', () => {
    let caught: unknown
    try {
      envVarNameOf(FAKE_VALUE)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SecretResolutionError)
    expect((caught as SecretResolutionError).code).toBe('INVALID_SECRET_REF')
    expect(String(caught)).not.toContain(FAKE_VALUE)
    expect((caught as Error).stack ?? '').not.toContain(FAKE_VALUE)
  })
})

describe('createEnvSecretResolver', () => {
  it('resolves a secret by name from the injected environment', async () => {
    const resolver = createEnvSecretResolver({ env: { [FAKE_NAME]: FAKE_VALUE } })
    const secret = await resolver.resolve(`env:${FAKE_NAME}`, ctx)
    expect(secret).toBeInstanceOf(SecretValue)
    expect(secret.reveal()).toBe(FAKE_VALUE)
    expect(secret.length).toBe(FAKE_VALUE.length)
  })

  it('reads the process environment by default', async () => {
    process.env[FAKE_NAME] = FAKE_VALUE
    const secret = await createEnvSecretResolver().resolve(`env:${FAKE_NAME}`, ctx)
    expect(secret.reveal()).toBe(FAKE_VALUE)
  })

  it('fails with a typed error when the referenced name is missing', async () => {
    const resolver = createEnvSecretResolver({ env: {} })
    await expect(resolver.resolve(`env:${FAKE_NAME}`, ctx)).rejects.toMatchObject({
      name: 'SecretResolutionError',
      code: 'SECRET_NOT_CONFIGURED',
    })
  })

  it('fails with a typed error when the referenced name is empty', async () => {
    const resolver = createEnvSecretResolver({ env: { [FAKE_NAME]: '' } })
    await expect(resolver.resolve(`env:${FAKE_NAME}`, ctx)).rejects.toMatchObject({
      name: 'SecretResolutionError',
      code: 'SECRET_EMPTY',
    })
  })

  it('never leaks the value through implicit string, JSON or template conversion', async () => {
    const resolver = createEnvSecretResolver({ env: { [FAKE_NAME]: FAKE_VALUE } })
    const secret = await resolver.resolve(`env:${FAKE_NAME}`, ctx)
    expect(String(secret)).toBe('[redacted]')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}')
    expect(`${secret}`).toBe('[redacted]')
    expect(secret.toString()).toBe('[redacted]')
    expect(secret.toJSON()).toBe('[redacted]')
  })

  it('never leaks the value into a resolution error', async () => {
    const resolver = createEnvSecretResolver({ env: { [FAKE_NAME]: '' } })
    let caught: unknown
    try {
      await resolver.resolve(`env:${FAKE_NAME}`, ctx)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SecretResolutionError)
    const rendered = `${String(caught)} ${(caught as Error).stack ?? ''} ${JSON.stringify(caught)}`
    expect(rendered).not.toContain(FAKE_VALUE)
    expect(rendered).toContain(FAKE_NAME)
  })

  it('redacts an occurrence of the resolved value from arbitrary text', async () => {
    const resolver = createEnvSecretResolver({ env: { [FAKE_NAME]: FAKE_VALUE } })
    const secret = await resolver.resolve(`env:${FAKE_NAME}`, ctx)
    expect(secret.redact(`authorization: Bearer ${FAKE_VALUE}`)).toBe(
      'authorization: Bearer [redacted]',
    )
  })
})
