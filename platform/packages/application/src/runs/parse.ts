import type { CreateRunContext, ProfileRef, RunPreferences } from '@ontology/contracts'
import { tryParseSemver } from '@ontology/contracts'
import { RunServiceError } from './errors'

export interface ParsedCreateRunRequest {
  readonly profileRef: ProfileRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
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
  return {
    profileRef: { id: profileId, version: profileVersion },
    question,
    context: parsedContext,
    preferences: { route, allowWeb },
  }
}
