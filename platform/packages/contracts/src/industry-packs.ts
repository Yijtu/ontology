import type { CapabilityRequirement } from './generated/contracts'
import { isValidContractRange } from './semver'

/**
 * Declaration-level guard for INV-03 / ADR-10 / US-023.
 *
 * An industry pack contains semantics and declarative constraints only. It never carries
 * an SDK dependency, a credential, a connection URL, a physical table/column name, a
 * customer instance or an executable script. The canonical JSON Schema already omits
 * every such field, so a smuggled value has to arrive as an unknown field or a free-form
 * string. This module rejects both before a pack is ever registered or exported.
 *
 * This is a declaration guard, not the only boundary: the composition root still resolves
 * every capability through the registry and adapters still own physical addressing. The
 * scanner exists so a leak is caught at the contract edge with a precise path.
 */

export type IndustryPackViolationCode =
  | 'forbidden_field'
  | 'uri_value'
  | 'credential_value'
  | 'script_value'

export interface IndustryPackViolation {
  readonly code: IndustryPackViolationCode
  /** JSON-pointer-ish location, e.g. `$.requiredCapabilities[0].versionRange`. */
  readonly path: string
  readonly message: string
}

/**
 * Field names that must never appear in an industry pack, normalized by lowercasing and
 * stripping `_`/`-`. Grouped by the invariant each protects.
 */
const FORBIDDEN_KEY_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'executable code or SDK dependency': [
    'sdk',
    'dependencies',
    'devdependencies',
    'peerdependencies',
    'optionaldependencies',
    'script',
    'scripts',
    'code',
    'eval',
    'command',
    'shell',
    'exec',
    'execute',
    'function',
    'handler',
    'module',
    'package',
    'entrypoint',
    'entrypointref',
    'import',
    'require',
  ],
  'physical connectivity or source object': [
    'url',
    'uri',
    'endpoint',
    'host',
    'hostname',
    'port',
    'jdbc',
    'dsn',
    'connectionstring',
    'databaseurl',
    'connection',
    'database',
    'dbname',
    'schema',
    'schemaname',
    'table',
    'tablename',
    'column',
    'columnname',
    'physicalcolumn',
    'objectpath',
    'sourceobjectref',
    'sql',
    'querytext',
  ],
  credential: [
    'credential',
    'credentials',
    'password',
    'passwd',
    'secret',
    'secrets',
    'apikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'privatekey',
    'clientsecret',
  ],
  'customer instance data': [
    'tenantid',
    'spaceid',
    'customerid',
    'customerref',
    'instanceid',
    'accountid',
    'subscriptionid',
    'siteref',
    'deviceid',
  ],
  'runtime or adapter binding': ['runtime', 'runtimeref', 'adapterref'],
}

const FORBIDDEN_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(FORBIDDEN_KEY_GROUPS).flatMap(([group, keys]) =>
    keys.map((key) => [key, group] as const),
  ),
)

const URI_PATTERN = /:\/\//
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const CREDENTIAL_PATTERN =
  /(?:^|[^a-z0-9])(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|bearer)\b/i
const SECRET_TOKEN_PATTERN =
  /\b(?:sk|pk|rk)[-_](?:live|test)[-_][A-Za-z0-9]{6,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/
const SCRIPT_PATTERN = /(?:^|\s)#!\s*\/|\beval\s*\(|<script\b|\brequire\s*\(/
const SQL_STATEMENT_PATTERN =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|ATTACH|INSTALL)\b/

function looksLikeCredential(value: string): boolean {
  return (
    PRIVATE_KEY_PATTERN.test(value) ||
    CREDENTIAL_PATTERN.test(value) ||
    SECRET_TOKEN_PATTERN.test(value)
  )
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

function scanValue(value: string, path: string, out: IndustryPackViolation[]): void {
  if (URI_PATTERN.test(value)) {
    out.push({
      code: 'uri_value',
      path,
      message: 'a connection URL or link is not allowed in an industry pack; use a registry ref',
    })
    return
  }
  if (looksLikeCredential(value)) {
    out.push({
      code: 'credential_value',
      path,
      message: 'a credential-looking value is not allowed in an industry pack',
    })
    return
  }
  if (SCRIPT_PATTERN.test(value)) {
    out.push({
      code: 'script_value',
      path,
      message: 'executable script content is not allowed in an industry pack',
    })
    return
  }
  if (SQL_STATEMENT_PATTERN.test(value)) {
    out.push({
      code: 'script_value',
      path,
      message: 'SQL statement text is not allowed in an industry pack; declare a logical role instead',
    })
  }
}

function walk(value: unknown, path: string, out: IndustryPackViolation[]): void {
  if (typeof value === 'string') {
    scanValue(value, path, out)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, out))
    return
  }
  if (value === null || typeof value !== 'object') return

  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    const group = FORBIDDEN_KEYS.get(normalizeKey(key))
    if (group !== undefined) {
      out.push({
        code: 'forbidden_field',
        path: childPath,
        message: `field "${key}" is forbidden in an industry pack (${group})`,
      })
    } else if (URI_PATTERN.test(key)) {
      out.push({ code: 'uri_value', path: childPath, message: 'a URL is not a valid industry pack field name' })
    }
    walk(entry, childPath, out)
  }
}

/**
 * Full industry-pack scan: forbidden fields plus credential/URL/script values anywhere in
 * the declaration tree. Returns every violation with its path; an empty array means the
 * declaration only contains semantics and refs.
 */
export function findIndustryPackViolations(declaration: unknown): IndustryPackViolation[] {
  const violations: IndustryPackViolation[] = []
  walk(declaration, '$', violations)
  return violations
}

/**
 * Narrow scan for secret material only (URLs, credentials, private keys). Used on
 * deployment profiles and exported configuration, where physical object paths and
 * adapter refs are legitimate but a secret value or connection string never is.
 */
export function findEmbeddedSecretViolations(value: unknown): IndustryPackViolation[] {
  const violations: IndustryPackViolation[] = []
  collectSecretViolations(value, '$', violations)
  return violations
}

function collectSecretViolations(value: unknown, path: string, out: IndustryPackViolation[]): void {
  if (typeof value === 'string') {
    if (URI_PATTERN.test(value)) {
      out.push({ code: 'uri_value', path, message: 'connection URL or link found in refs-only config' })
      return
    }
    if (looksLikeCredential(value)) {
      out.push({ code: 'credential_value', path, message: 'credential-looking value found in refs-only config' })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretViolations(entry, `${path}[${index}]`, out))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    collectSecretViolations(entry, `${path}.${key}`, out)
  }
}

/**
 * True when a pack declares at least one required capability and every declared range is a
 * well-formed `[min, max)`. Ordering cannot be expressed in JSON Schema, so registration
 * must call this in addition to schema validation.
 */
export function hasWellFormedCapabilityRequirements(
  requiredCapabilities: readonly CapabilityRequirement[],
): boolean {
  return (
    requiredCapabilities.length > 0 &&
    requiredCapabilities.every(
      (requirement) =>
        requirement.name.length > 0 && isValidContractRange(requirement.versionRange),
    )
  )
}
