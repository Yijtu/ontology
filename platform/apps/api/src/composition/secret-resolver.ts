import { SecretValue } from '@ontology/contracts'
import type { SecretResolver } from '@ontology/contracts'

/**
 * Environment-backed `SecretResolver` (SPEC C1/C2, §8).
 *
 * A `secretRef` is an opaque, server-side name, never a value: this resolver maps it
 * onto a process-environment variable and returns the resolved material wrapped in the
 * non-serializable `SecretValue`, whose implicit string/JSON conversion is `[redacted]`.
 * The composition root injects it where a port needs a credential; the application layer
 * resolves a ref only at the point of use and never persists or returns the value.
 *
 * Accepted ref forms (the value is the variable NAME, never the secret):
 *   - `env:ONTOLOGY_COMPANY_MODEL_API_KEY`
 *   - `env://ONTOLOGY_COMPANY_MODEL_API_KEY`
 *   - `secret://env/ONTOLOGY_COMPANY_MODEL_API_KEY`
 *   - a bare `ONTOLOGY_COMPANY_MODEL_API_KEY`
 *
 * The resolver never reads a file and never hardcodes a path: the operator supplies the
 * environment (for example through Node's `--env-file`), so the secrets file location is
 * not part of repository configuration.
 */

export type SecretResolutionErrorCode =
  | 'INVALID_SECRET_REF'
  | 'SECRET_NOT_CONFIGURED'
  | 'SECRET_EMPTY'

/**
 * Typed resolution failure. The message carries only the variable NAME (which is not a
 * secret); the referenced value is never read into, or echoed from, this error.
 */
export class SecretResolutionError extends Error {
  readonly code: SecretResolutionErrorCode

  constructor(code: SecretResolutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SecretResolutionError'
    this.code = code
  }
}

export interface EnvSecretResolverOptions {
  /** Environment source; defaults to `process.env`. Injected so tests never touch the real one. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const ENV_SCHEME = 'env'
const SECRET_SCHEME = 'secret'
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Extract the environment-variable name a `secretRef` names. Throws a typed
 * `INVALID_SECRET_REF` for anything that is not a recognised opaque reference; the
 * rejected text is deliberately not included in the message, so a caller that mistakenly
 * passes a raw value cannot turn the error into a leak.
 */
export function envVarNameOf(secretRef: string): string {
  if (typeof secretRef !== 'string' || secretRef.length === 0) {
    throw new SecretResolutionError(
      'INVALID_SECRET_REF',
      'a secretRef must name an environment variable, e.g. "env:ONTOLOGY_COMPANY_MODEL_API_KEY"',
    )
  }
  const bare = secretRef.trim()
  if (bare.startsWith(`${ENV_SCHEME}:`)) {
    const rest = bare.slice(ENV_SCHEME.length + 1).replace(/^\/\//, '')
    return assertEnvVarName(rest)
  }
  if (bare.startsWith(`${SECRET_SCHEME}://${ENV_SCHEME}/`)) {
    return assertEnvVarName(bare.slice(`${SECRET_SCHEME}://${ENV_SCHEME}/`.length))
  }
  return assertEnvVarName(bare)
}

function assertEnvVarName(name: string): string {
  if (!ENV_VAR_PATTERN.test(name)) {
    throw new SecretResolutionError(
      'INVALID_SECRET_REF',
      'a secretRef must name an environment variable, e.g. "env:ONTOLOGY_COMPANY_MODEL_API_KEY"',
    )
  }
  return name
}

/**
 * Create the environment-backed resolver. It satisfies the existing `SecretResolver`
 * port unchanged and resolves a ref by NAME against the injected environment.
 */
export function createEnvSecretResolver(options: EnvSecretResolverOptions = {}): SecretResolver {
  const env = options.env ?? process.env
  return {
    async resolve(secretRef: string): Promise<SecretValue> {
      const name = envVarNameOf(secretRef)
      const raw = env[name]
      if (raw === undefined) {
        throw new SecretResolutionError(
          'SECRET_NOT_CONFIGURED',
          `the secret "${name}" is not configured in the process environment`,
        )
      }
      if (raw.length === 0) {
        throw new SecretResolutionError(
          'SECRET_EMPTY',
          `the secret "${name}" is configured but empty`,
        )
      }
      return new SecretValue(raw)
    },
  }
}
