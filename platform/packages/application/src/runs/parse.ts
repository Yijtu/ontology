import type {
  CreateRunContext,
  ProfileRef,
  RunExecutionRequest,
  RunPreferences,
} from '@ontology/contracts'
import { isRunExecutionRequest, tryParseSemver } from '@ontology/contracts'
import { RunServiceError } from './errors'

export interface ParsedCreateRunRequest {
  readonly profileRef: ProfileRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly execution?: RunExecutionRequest
}

/**
 * Validate the optional `task` execution binding on the run request. The body is untrusted, so
 * the shape is checked field by field and the canonical union guard is the final gate; scope and
 * identity are deliberately absent (they come from the trusted context, never the request).
 */
function parseRunExecutionRequest(value: unknown): RunExecutionRequest | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'task must be an object')
  }
  if (!isRunExecutionRequest(value)) {
    throw new RunServiceError(
      'INVALID_ARGUMENT',
      'task must be a question/task execution request pinning projectRevisionRef, inputSnapshotRef and inputSnapshotDigest',
    )
  }
  return value
}

function isRunRoute(value: unknown): value is RunPreferences['route'] {
  return value === 'auto' || value === 'template' || value === 'pi'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RunServiceError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

/**
 * Validate the untrusted `CreateRunRequest` body and narrow it to typed fields. It accepts
 * `unknown` and performs every check explicitly, so neither the HTTP layer nor the service
 * needs a type assertion to cross the wire boundary. Identity, budget and the tool allowlist
 * are intentionally absent: they are established by the server, never by the request body.
 */
export function parseCreateRunRequest(body: unknown): ParsedCreateRunRequest {
  if (!isRecord(body)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
  }
  const profileRef = body['profileRef']
  if (!isRecord(profileRef)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'profileRef must be an object')
  }
  const profileId = requireNonEmptyString(profileRef['id'], 'profileRef.id')
  const profileVersion = requireNonEmptyString(profileRef['version'], 'profileRef.version')
  if (tryParseSemver(profileVersion) === undefined) {
    throw new RunServiceError('INVALID_ARGUMENT', 'profileRef.version must be a semver string')
  }
  const question = requireNonEmptyString(body['question'], 'question')

  const context = body['context']
  if (!isRecord(context)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'context must be an object')
  }
  const timeZone = requireNonEmptyString(context['timeZone'], 'context.timeZone')
  if (context['siteRef'] !== undefined) {
    requireNonEmptyString(context['siteRef'], 'context.siteRef')
  }

  const preferences = body['preferences']
  if (!isRecord(preferences)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'preferences must be an object')
  }
  const route = preferences['route']
  if (!isRunRoute(route)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'preferences.route must be auto, template or pi')
  }
  const allowWeb = preferences['allowWeb']
  if (typeof allowWeb !== 'boolean') {
    throw new RunServiceError('INVALID_ARGUMENT', 'preferences.allowWeb must be a boolean')
  }

  const parsedContext: CreateRunContext = { ...context, timeZone }
  if (typeof context['siteRef'] === 'string' && context['siteRef'].length > 0) {
    parsedContext.siteRef = context['siteRef']
  }
  const execution = parseRunExecutionRequest(body['task'])
  return {
    profileRef: { id: profileId, version: profileVersion },
    question,
    context: parsedContext,
    preferences: { route, allowWeb },
    ...(execution === undefined ? {} : { execution }),
  }
}
