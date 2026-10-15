import {
  isInstanceRecordView,
  isRevisionString,
  isUuid,
} from '@ontology/contracts'
import type {
  InstanceConfirmationEvent,
  InstanceFieldDecision,
  InstanceFieldSource,
  InstanceIdentityConfidence,
  InstanceIdentityState,
  InstanceNormalizedValue,
  InstanceRecordView,
  InstanceRawValue,
  RevisionString,
} from '@ontology/contracts'

/**
 * Wire shapes for the public instance review surface (V03-013 / #182, SPEC v0.3a §3.3/§8.1).
 *
 * The browser talks to the API over HTTP only, so the request shapes and their runtime guards
 * live here around the canonical `@ontology/contracts` record shape. A well-formed envelope
 * carrying an unrecognised record is an explicit failure, never a guessed record that could be
 * confirmed or published with the wrong revision.
 */

export interface CreateInstanceFieldInput {
  readonly fieldId: string
  readonly rawValue: InstanceRawValue
  readonly normalizedValue?: InstanceNormalizedValue
  readonly source: InstanceFieldSource
}

export interface CreateInstanceRelationInput {
  readonly relationId: string
  readonly relationTypeRef: string
  readonly toRecordId?: string
}

export interface CreateInstanceRecordRequest {
  readonly candidateId: string
  readonly documentId: string
  readonly relations?: readonly CreateInstanceRelationInput[]
}

export interface EditInstanceFieldRequest {
  readonly expectedRevision: RevisionString
  readonly fieldId: string
  readonly rawValue?: InstanceRawValue
  readonly normalizedValue?: InstanceNormalizedValue
  readonly reason: string
}

export interface InstanceFieldDecisionInput {
  readonly fieldId: string
  readonly decision: InstanceFieldDecision
  readonly reason?: string
}

export interface ConfirmInstanceFieldsRequest {
  readonly expectedRevision: RevisionString
  readonly decisions: readonly InstanceFieldDecisionInput[]
}

export interface InstanceIdentityDecisionRequest {
  readonly expectedRevision: RevisionString
  readonly kind: 'match' | 'cannot_link' | 'split' | 'create'
  readonly targetEntityId?: string
  readonly reason: string
}

export interface InstanceRevisionRequest {
  readonly expectedRevision: RevisionString
}

export interface InstanceConfirmationOutcomeView {
  readonly record: InstanceRecordView
  readonly accepted: readonly { readonly fieldId: string; readonly status: 'pending' | 'confirmed' | 'conflict' }[]
  readonly skipped: readonly { readonly fieldId: string; readonly reason: string }[]
}

export type InstanceRecordFilter = {
  readonly status?: 'pending' | 'confirmed' | 'conflict'
  readonly publicationState?: 'draft' | 'approved' | 'published'
}

export { isInstanceRecordView }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isInstanceConfirmationEvent(value: unknown): value is InstanceConfirmationEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isUuid(record['projectId']) &&
    isUuid(record['recordId']) &&
    isNonEmptyString(record['fieldId']) &&
    isRevisionString(record['recordRevision']) &&
    isRevisionString(record['confirmationRevision']) &&
    (record['status'] === 'pending' || record['status'] === 'confirmed' || record['status'] === 'conflict') &&
    isNonEmptyString(record['actor'])
  )
}

export function isInstanceConfirmationOutcome(value: unknown): value is InstanceConfirmationOutcomeView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isInstanceRecordView(record['record']) &&
    Array.isArray(record['accepted']) &&
    Array.isArray(record['skipped'])
  )
}

export type {
  InstanceConfirmationEvent,
  InstanceIdentityConfidence,
  InstanceIdentityState,
}
