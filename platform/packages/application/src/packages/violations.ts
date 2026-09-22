import { findIndustryPackViolations } from '@ontology/contracts'

/**
 * Negative scan over an exported pack bundle (US-023.A2, T023b).
 *
 * A portable export contains declarations only. The canonical industry-pack scanner already
 * rejects forbidden fields, URLs, credentials and script/SQL text; on top of that this scan
 * names the two leaks the export specifically promises to exclude — customer instance data
 * (scope/tenant/space/run identifiers) and identity decisions (an adjudicated entity id).
 */
export type PackExportViolationCode =
  | 'forbidden_field'
  | 'uri_value'
  | 'credential_value'
  | 'script_value'
  | 'customer_data'
  | 'identity_decision'

export interface PackExportViolation {
  readonly code: PackExportViolationCode
  readonly path: string
  readonly message: string
}

const CUSTOMER_DATA_KEYS: ReadonlySet<string> = new Set([
  'scoperef',
  'tenantid',
  'spaceid',
  'runid',
  'customerid',
  'customerref',
  'instanceid',
  'accountid',
  'subscriptionid',
  'siteref',
  'deviceid',
])

const IDENTITY_DECISION_KEYS: ReadonlySet<string> = new Set([
  'decision',
  'decisions',
  'identitydecision',
  'identitydecisions',
  'entityid',
  'entityref',
])

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

function walk(value: unknown, path: string, out: PackExportViolation[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, out))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    const normalized = normalizeKey(key)
    if (CUSTOMER_DATA_KEYS.has(normalized)) {
      out.push({
        code: 'customer_data',
        path: childPath,
        message: `field "${key}" would leak customer instance data into the export`,
      })
    } else if (IDENTITY_DECISION_KEYS.has(normalized)) {
      out.push({
        code: 'identity_decision',
        path: childPath,
        message: `field "${key}" would leak an identity decision into the export`,
      })
    }
    walk(entry, childPath, out)
  }
}

/** Every way an export bundle could leak a non-declaration value; empty means portable. */
export function findPackExportViolations(bundle: unknown): PackExportViolation[] {
  const violations: PackExportViolation[] = findIndustryPackViolations(bundle).map((violation) => ({
    code: violation.code,
    path: violation.path,
    message: violation.message,
  }))
  walk(bundle, '$', violations)
  return violations
}
