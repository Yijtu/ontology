import type { FieldError, ResultLimits, ResourceKind, ToolContext } from '@ontology/contracts'
import { ToolGatewayError } from './errors'
import { canonicalJson } from './types'

/** The default up-front row estimate when the call does not state its own limit. */
export const DEFAULT_RESERVE_ROWS = 100

const MAX_ARGUMENT_DEPTH = 32
/** Total canonical byte size of the arguments; an oversized request is refused, not trimmed. */
export const MAX_ARGUMENT_BYTES = 262_144
/** Per-array ceiling. The canonical schemas bound scalar fields but not collection sizes. */
export const MAX_ARGUMENT_ITEMS = 1_000
/** Per-string ceiling, so a single field cannot smuggle a huge payload. */
export const MAX_ARGUMENT_STRING = 65_536

/**
 * Keys that can never appear anywhere in a model-proposed tool argument graph.
 *
 * `__proto__`/`constructor`/`prototype` are prototype-pollution shapes: `JSON.parse`
 * materialises `__proto__` as an own key, so scanning own keys is sufficient. The
 * script-shaped names are the ADR-11 ban on arbitrary code: `data_query.compute`
 * references a *registered* operation, never a handler path or a script body.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'code',
  'script',
  'eval',
  'exec',
  'handler',
  'handlerRef',
  'packagePath',
  'modulePath',
])

/**
 * Top-level fields that only the host may supply. They are not part of any tool input
 * schema, and honouring one would let a model forge identity, widen the allowlist or
 * choose its own budget/deadline.
 */
const IDENTITY_FIELDS: readonly string[] = [
  'principal',
  'tenantId',
  'spaceId',
  'subjectId',
  'authEpoch',
  'runId',
  'scope',
  'toolContext',
  'budgetReservation',
  'allowedResources',
  'resolvedProfileHash',
  'policyVersion',
  'deadline',
  'traceId',
]

/**
 * Bound the request itself before anything executes. The canonical input schemas cap
 * scalar ranges but not collection sizes, so an oversized array, string or total payload
 * is refused with a classified limit error instead of being silently trimmed or handed to
 * a backend.
 */
export function assertBoundedArguments(args: Readonly<Record<string, unknown>>): void {
  const issues: FieldError[] = []
  const visit = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      if (node.length > MAX_ARGUMENT_ITEMS) {
        issues.push(
          fieldError(pointer, `array length ${String(node.length)} exceeds ${String(MAX_ARGUMENT_ITEMS)}`),
        )
        return
      }
      node.forEach((entry, index) => visit(entry, `${pointer}/${String(index)}`))
      return
    }
    if (typeof node === 'string') {
      if (node.length > MAX_ARGUMENT_STRING) {
        issues.push(
          fieldError(pointer, `string length ${String(node.length)} exceeds ${String(MAX_ARGUMENT_STRING)}`),
        )
      }
      return
    }
    if (!isRecord(node)) return
    for (const [key, entry] of Object.entries(node)) {
      visit(entry, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    }
  }
  visit(args, '')
  if (issues.length > 0) {
    throw new ToolGatewayError(
      'LIMIT_EXCEEDED',
      'the tool arguments exceed the bounded request size',
      { fieldErrors: issues },
    )
  }
  const byteSize = new TextEncoder().encode(canonicalJson(args)).byteLength
  if (byteSize > MAX_ARGUMENT_BYTES) {
    throw new ToolGatewayError(
      'LIMIT_EXCEEDED',
      `the tool arguments are ${String(byteSize)} bytes and exceed the ${String(MAX_ARGUMENT_BYTES)} byte ceiling`,
    )
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldError(pointer: string, reason: string): FieldError {
  return { pointer, reason }
}

/**
 * Reject prototype-pollution and arbitrary-code keys anywhere in the argument graph.
 * Depth is bounded so a deeply nested payload cannot be used as a stack-exhaustion
 * vector before execution.
 */
export function assertNoMaliciousKeys(value: unknown): void {
  const issues: FieldError[] = []
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (depth > MAX_ARGUMENT_DEPTH) {
      issues.push(fieldError(pointer, `argument nesting exceeds ${String(MAX_ARGUMENT_DEPTH)} levels`))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${pointer}/${String(index)}`, depth + 1))
      return
    }
    if (!isRecord(node)) return
    for (const [key, entry] of Object.entries(node)) {
      const childPointer = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(fieldError(childPointer, `the key ${key} is not permitted in a tool argument`))
        continue
      }
      visit(entry, childPointer, depth + 1)
    }
  }
  visit(value, '', 0)
  if (issues.length > 0) {
    throw new ToolGatewayError(
      'MALICIOUS_ARGUMENTS',
      'the tool arguments contain a forbidden prototype-pollution or script-shaped key',
      { fieldErrors: issues },
    )
  }
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Enforce that every identity/allowlist value in the arguments is inside the trusted
 * context envelope. Identity is never *taken* from input: a mismatching `scopeRef` or a
 * wider allowlist is rejected, and the gateway always executes with the context scope.
 */
export function assertTrustedEnvelope(
  args: Readonly<Record<string, unknown>>,
  ctx: ToolContext,
): void {
  const issues: FieldError[] = []
  for (const field of IDENTITY_FIELDS) {
    if (Object.hasOwn(args, field)) {
      issues.push(fieldError(`/${field}`, `identity and host-only field ${field} is not accepted from input`))
    }
  }
  if (issues.length > 0) {
    throw new ToolGatewayError(
      'INVALID_ARGUMENTS',
      'the tool arguments carry host-only identity fields',
      { fieldErrors: issues },
    )
  }

  const trustedTenant = ctx.principal.tenantId
  const trustedSpace = ctx.allowedResources.spaceId
  const scopeRef = args.scopeRef
  if (isRecord(scopeRef)) {
    if (scopeRef.tenantId !== trustedTenant || scopeRef.spaceId !== trustedSpace) {
      throw new ToolGatewayError(
        'RESOURCE_NOT_ALLOWED',
        'the requested scope is outside the trusted context scope',
        { fieldErrors: [fieldError('/scopeRef', 'scope does not match the trusted principal scope')] },
      )
    }
  }

  const collections = readStringArray(args.allowedCollectionRefs)
  if (collections !== undefined) {
    const allowed = ctx.allowedResources.collectionRefs
    const denied = collections.filter((entry) => !allowed.includes(entry))
    if (denied.length > 0) {
      throw new ToolGatewayError(
        'RESOURCE_NOT_ALLOWED',
        'the requested collections are outside the approved collection set',
        {
          fieldErrors: denied.map((entry) =>
            fieldError('/allowedCollectionRefs', `collection ${entry} is not approved for this context`),
          ),
        },
      )
    }
  }

  const domains = readStringArray(args.allowedDomains)
  if (domains !== undefined) {
    const allowed = ctx.allowedResources.domains
    const denied = domains.filter((entry) => !allowed.includes(entry))
    if (denied.length > 0) {
      throw new ToolGatewayError(
        'RESOURCE_NOT_ALLOWED',
        'the requested domains are outside the approved domain set',
        {
          fieldErrors: denied.map((entry) =>
            fieldError('/allowedDomains', `domain ${entry} is not approved for this context`),
          ),
        },
      )
    }
  }

  const inputRefs = args.inputRefs
  if (Array.isArray(inputRefs)) {
    const allowedKinds = ctx.allowedResources.resourceKinds
    for (const [index, entry] of inputRefs.entries()) {
      if (!isRecord(entry)) continue
      const kind = entry.kind
      if (typeof kind === 'string' && !allowedKinds.includes(kind as ResourceKind)) {
        throw new ToolGatewayError(
          'RESOURCE_NOT_ALLOWED',
          'a compute input reference is outside the approved resource kinds',
          {
            fieldErrors: [
              fieldError(`/inputRefs/${String(index)}/kind`, `resource kind ${kind} is not approved`),
            ],
          },
        )
      }
    }
  }

  const queryPlan = args.queryPlan
  if (isRecord(queryPlan)) {
    const referenced = queryPlan.referencedObjects
    if (Array.isArray(referenced)) {
      const allowedSources = ctx.allowedResources.sourceRefs
      for (const [index, entry] of referenced.entries()) {
        if (!isRecord(entry)) continue
        const sourceRef = entry.sourceRef
        if (!isRecord(sourceRef)) continue
        const approved = allowedSources.some(
          (candidate) =>
            candidate.namespace === sourceRef.namespace && candidate.sourceId === sourceRef.sourceId,
        )
        if (!approved) {
          throw new ToolGatewayError(
            'RESOURCE_NOT_ALLOWED',
            'a referenced source object is outside the approved source set',
            {
              fieldErrors: [
                fieldError(
                  `/queryPlan/referencedObjects/${String(index)}/sourceRef`,
                  'source is not approved for this context',
                ),
              ],
            },
          )
        }
      }
    }
  }
}

/**
 * Reject a requested row limit above the tool's declared ceiling. Schema validation
 * already bounds `limit`, but this keeps the ceiling a gateway invariant rather than a
 * schema-only property, and never silently truncates a too-large request.
 */
export function assertRequestedLimit(
  args: Readonly<Record<string, unknown>>,
  limits: ResultLimits,
): void {
  const requested = args.limit
  if (requested === undefined) return
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'limit must be a positive integer', {
      fieldErrors: [fieldError('/limit', 'limit must be a positive integer')],
    })
  }
  if (requested > limits.maxRows) {
    throw new ToolGatewayError(
      'LIMIT_EXCEEDED',
      `the requested limit ${String(requested)} exceeds the tool ceiling of ${String(limits.maxRows)} rows`,
      { fieldErrors: [fieldError('/limit', `limit exceeds the maximum of ${String(limits.maxRows)}`)] },
    )
  }
}

/** The up-front row estimate charged before the call executes. */
export function estimatedReservationRows(
  args: Readonly<Record<string, unknown>>,
  limits: ResultLimits,
): number {
  const requested = args.limit
  const estimate =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_RESERVE_ROWS
  return Math.min(estimate, limits.maxRows)
}
