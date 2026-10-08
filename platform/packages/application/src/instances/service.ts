import { InstanceReviewError, isToolContext } from '@ontology/contracts'
import type {
  InstanceFieldSource,
  InstanceFieldValue,
  InstanceIdentityAdjudication,
  InstanceIdentityCandidate,
  InstanceIdentityBinding,
  InstanceIdentityConfidence,
  InstanceIdentityState,
  InstanceNormalizedValue,
  InstanceRawValue,
  InstanceRecordView,
  InstanceRelationEndpoint,
  InstanceReviewListFilter,
  InstanceReviewStore,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/**
 * Public instance review service (SPEC v0.3a asset-data-ui §3.3/§3.4, §8.1; A.US-004,
 * P.US-008/010/014). It orchestrates the append-only instance record and its key-field
 * confirmation flow over the injected `InstanceReviewStore`:
 *
 *  - a record keeps a stable `recordId` and its revisions are never rewritten; an identity
 *    merge changes only the identity state, so a duplicate entity never deletes a business row;
 *  - key fields show the raw value, the normalized value, the source and a
 *    pending/confirmed/conflict status; a modified field re-enters `pending` and must be
 *    re-checked before approval;
 *  - an unknown field or an unresolved relation endpoint stays `pending` and blocks
 *    publication (`P.US-008.AC-03`);
 *  - identity adjudication (match / cannot_link / split / create) is recorded with a reason
 *    and revision, and a candidate that collides on display name but is a different object is
 *    flagged `sameNameDifferentMeaning`;
 *  - `approve` and `publish` are distinct operations, and `publish` pins a revision a later
 *    read-back returns.
 *
 * Schema-level field validation is injected via `InstanceFieldPolicy` so the service never
 * imports the tables that hold the published definition.
 */

/** Injected schema check for a normalized field value. */
export interface InstanceFieldPolicy {
  /**
   * Return `undefined` when the field is known and the normalized value is acceptable for the
   * record's object. Return a human-readable reason when the field is unknown, the unit is
   * wrong or the value is otherwise not publishable.
   */
  validate(input: {
    readonly objectTypeRef: string
    readonly fieldId: string
    readonly rawValue: InstanceRawValue
    readonly normalizedValue?: InstanceNormalizedValue
  }): string | undefined
}

export interface InstanceReviewServiceDependencies {
  readonly store: InstanceReviewStore
  /** Optional published-schema field validation; absent means structural checks only. */
  readonly fieldPolicy?: InstanceFieldPolicy
  readonly newId?: () => string
  readonly now?: () => string
}

export interface CreateInstanceFieldInput {
  readonly fieldId: string
  readonly rawValue: InstanceRawValue
  readonly normalizedValue?: InstanceNormalizedValue
  readonly source: InstanceFieldSource
}

export interface CreateInstanceRelationInput {
  readonly relationId: string
  readonly relationTypeRef: string
  readonly toRecordId?: Uuid
}

export interface CreateInstanceRecordInput {
  readonly identityBinding?: InstanceIdentityBinding
  readonly recordId?: Uuid
  readonly objectTypeRef: string
  /** The record's own display name, used to detect a same-name/different-object collision. */
  readonly displayName?: string
  readonly identityCandidates: readonly InstanceIdentityCandidate[]
  readonly fields: readonly CreateInstanceFieldInput[]
  readonly relations: readonly CreateInstanceRelationInput[]
  readonly sourceRef: ResourceRef
  readonly actor: string
  readonly idempotencyKey: string
}

export interface RecordFieldEditInput {
  readonly expectedRevision: RevisionString
  readonly fieldId: string
  readonly rawValue?: InstanceRawValue
  readonly normalizedValue?: InstanceNormalizedValue
  readonly reason: string
  readonly idempotencyKey: string
}

export interface FieldConfirmationDecisionInput {
  readonly fieldId: string
  readonly decision: 'confirm' | 'conflict' | 'reject'
  readonly reason?: string
}

export interface FieldConfirmationInput {
  readonly expectedRevision: RevisionString
  readonly decisions: readonly FieldConfirmationDecisionInput[]
  readonly idempotencyKey: string
}

export interface IdentityAdjudicationInput {
  /** Trusted decision service's entity id when creating an identity. Not an HTTP body field. */
  readonly resolvedEntityId?: string
  readonly expectedRevision: RevisionString
  readonly kind: 'match' | 'cannot_link' | 'split' | 'create'
  readonly targetEntityId?: string
  readonly reason: string
  readonly idempotencyKey: string
}

export interface FieldConfirmationOutcome {
  readonly record: InstanceRecordView
  readonly accepted: readonly { readonly fieldId: string; readonly status: InstanceFieldValue['status'] }[]
  readonly skipped: readonly { readonly fieldId: string; readonly reason: string }[]
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new InstanceReviewError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new InstanceReviewError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nextRevision(current: RevisionString): RevisionString {
  if (!/^(?:0|[1-9]\d*)$/.test(current)) {
    throw new InstanceReviewError('INVALID_ARGUMENT', `revision ${current} is not a canonical integer`)
  }
  return (BigInt(current) + 1n).toString()
}

function confidenceFromCandidates(
  objectTypeRef: string,
  candidates: readonly InstanceIdentityCandidate[],
): InstanceIdentityConfidence {
  if (candidates.some((candidate) => candidate.strategy === 'native_id' && candidate.objectId === objectTypeRef)) {
    return 'exact'
  }
  return candidates.length > 0 ? 'candidate' : 'none'
}

function sameNameDifferentMeaningOf(
  objectTypeRef: string,
  displayName: string | undefined,
  candidates: readonly InstanceIdentityCandidate[],
): boolean {
  if (!nonEmpty(displayName)) return false
  const normalized = displayName.trim().toLowerCase()
  return candidates.some(
    (candidate) =>
      candidate.objectId !== objectTypeRef && candidate.displayName.trim().toLowerCase() === normalized,
  )
}

export class InstanceReviewService {
  readonly #deps: InstanceReviewServiceDependencies
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: InstanceReviewServiceDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: InstanceReviewListFilter,
    ctx: ToolContext,
  ): Promise<InstanceRecordView[]> {
    scopeOf(ctx)
    return this.#deps.store.listRecords(scopeRef, projectId, filter, ctx)
  }

  async getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    return this.#requireRecord(scopeRef, projectId, recordId, ctx)
  }

  async listConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ) {
    scopeOf(ctx)
    return this.#deps.store.listConfirmations(scopeRef, projectId, recordId, ctx)
  }

  async createRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: CreateInstanceRecordInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    if (!nonEmpty(input.objectTypeRef)) {
      throw new InstanceReviewError('INVALID_ARGUMENT', 'objectTypeRef must be a non-empty string')
    }
    if (input.fields.length === 0) {
      throw new InstanceReviewError('INVALID_ARGUMENT', 'a record must carry at least one field')
    }
    const recordId = input.recordId ?? this.#newId()
    const recordedAt = this.#now()
    const fields = input.fields.map((field) => this.#initialField(input.objectTypeRef, field))
    const relations = await this.#resolveRelations(scopeRef, projectId, recordId, input.relations, ctx)
    const confidence = confidenceFromCandidates(input.objectTypeRef, input.identityCandidates)
    const sameNameDifferentMeaning = sameNameDifferentMeaningOf(
      input.objectTypeRef,
      input.displayName,
      input.identityCandidates,
    )
    return this.#deps.store.appendRecordRevision(
      scopeRef,
      projectId,
      {
        recordId,
        expectedRevision: '0',
        objectTypeRef: input.objectTypeRef,
        identityCandidates: input.identityCandidates,
        ...(input.identityBinding === undefined ? {} : { identityBinding: input.identityBinding }),
        identityState: 'unresolved',
        identityConfidence: confidence,
        sameNameDifferentMeaning,
        cannotLinkEntityIds: [],
        adjudications: [],
        fields,
        relations,
        publicationState: 'draft',
        sourceRef: input.sourceRef,
        actor: input.actor,
        recordedAt,
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )
  }

  /** Modify one key field: append a record revision plus a `pending` confirmation event. */
  async editField(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    input: RecordFieldEditInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    if (!nonEmpty(input.reason)) {
      throw new InstanceReviewError('INVALID_ARGUMENT', 'a field edit requires a non-empty reason')
    }
    const record = await this.#requireRecord(scopeRef, projectId, recordId, ctx)
    if (record.recordRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record is at revision ${record.recordRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    const index = record.fields.findIndex((field) => field.fieldId === input.fieldId)
    const current = record.fields[index]
    if (index < 0 || current === undefined) {
      throw new InstanceReviewError('FIELD_NOT_FOUND', `field ${input.fieldId} is not on record ${recordId}`)
    }
    const rawValue = input.rawValue ?? current.rawValue
    const normalizedValue = input.normalizedValue ?? current.normalizedValue
    const rejection = this.#deps.fieldPolicy?.validate({
      objectTypeRef: record.objectTypeRef,
      fieldId: input.fieldId,
      rawValue,
      ...(normalizedValue === undefined ? {} : { normalizedValue }),
    })
    const status: InstanceFieldValue['status'] = rejection === undefined ? 'pending' : 'conflict'
    const recordedAt = this.#now()
    const confirmationRevision = nextRevision(current.confirmationRevision)
    const updated: InstanceFieldValue = {
      ...current,
      rawValue,
      ...(normalizedValue === undefined ? {} : { normalizedValue }),
      status,
      ...(rejection === undefined ? { reason: input.reason } : { reason: rejection }),
      confirmationRevision,
    }
    await this.#deps.store.appendConfirmation(
      scopeRef,
      projectId,
      {
        recordId,
        fieldId: input.fieldId,
        recordRevision: record.recordRevision,
        status,
        reason: rejection ?? input.reason,
        sourceRef: current.source.documentRef,
        actor: record.actor,
        recordedAt,
        idempotencyKey: `${input.idempotencyKey}:event`,
      },
      ctx,
    )
    const fields = record.fields.map((field, position) => (position === index ? updated : field))
    return this.#appendRevision(scopeRef, projectId, record, ctx, {
      recordId,
      fields,
      publicationState: 'draft',
      recordedAt,
      idempotencyKey: input.idempotencyKey,
    })
  }

  /** Confirm / conflict / reject a batch of explicit fields. Unknown fields are skipped. */
  async confirmFields(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    input: FieldConfirmationInput,
    ctx: ToolContext,
  ): Promise<FieldConfirmationOutcome> {
    scopeOf(ctx)
    const record = await this.#requireRecord(scopeRef, projectId, recordId, ctx)
    if (record.recordRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record is at revision ${record.recordRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    const recordedAt = this.#now()
    const accepted: { fieldId: string; status: InstanceFieldValue['status'] }[] = []
    const skipped: { fieldId: string; reason: string }[] = []
    const byField = new Map(input.decisions.map((decision) => [decision.fieldId, decision]))
    const fields: InstanceFieldValue[] = []

    for (const field of record.fields) {
      const decision = byField.get(field.fieldId)
      if (decision === undefined) {
        fields.push(field)
        continue
      }
      if (decision.decision === 'confirm') {
        const block = this.#confirmBlocker(record.objectTypeRef, field)
        if (block !== undefined) {
          skipped.push({ fieldId: field.fieldId, reason: block })
          fields.push(field)
          await this.#recordConfirmation(scopeRef, projectId, record, field, 'pending', block, recordedAt, input, ctx)
          continue
        }
        const status: InstanceFieldValue['status'] = 'confirmed'
        fields.push({
          ...field,
          status,
          actor: record.actor,
          confirmedAt: recordedAt,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          confirmationRevision: nextRevision(field.confirmationRevision),
        })
        accepted.push({ fieldId: field.fieldId, status })
        await this.#recordConfirmation(scopeRef, projectId, record, field, status, decision.reason, recordedAt, input, ctx)
        continue
      }
      const status: InstanceFieldValue['status'] = decision.decision === 'conflict' ? 'conflict' : 'pending'
      fields.push({
        ...field,
        status,
        actor: record.actor,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        confirmationRevision: nextRevision(field.confirmationRevision),
      })
      accepted.push({ fieldId: field.fieldId, status })
      await this.#recordConfirmation(scopeRef, projectId, record, field, status, decision.reason, recordedAt, input, ctx)
    }
    for (const decision of input.decisions) {
      if (record.fields.some((field) => field.fieldId === decision.fieldId)) continue
      skipped.push({ fieldId: decision.fieldId, reason: 'unknown field' })
      await this.#recordConfirmation(
        scopeRef,
        projectId,
        record,
        undefined,
        'pending',
        'unknown field',
        recordedAt,
        input,
        ctx,
        decision.fieldId,
      )
    }

    const updated = await this.#appendRevision(scopeRef, projectId, record, ctx, {
      recordId,
      fields,
      publicationState: 'draft',
      recordedAt,
      idempotencyKey: input.idempotencyKey,
    })
    return { record: updated, accepted, skipped }
  }

  /** Record a match / cannot-link / split / create identity adjudication with a reason. */
  async adjudicateIdentity(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    input: IdentityAdjudicationInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    if (!nonEmpty(input.reason)) {
      throw new InstanceReviewError('INVALID_ARGUMENT', 'an identity adjudication requires a non-empty reason')
    }
    const record = await this.#requireRecord(scopeRef, projectId, recordId, ctx)
    if (record.recordRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record is at revision ${record.recordRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    const candidates = record.identity.candidates
    const recordedAt = this.#now()
    let state: InstanceIdentityState = record.identity.state
    let matchedEntityId = record.identity.matchedEntityId
    const cannotLink = new Set(record.identity.cannotLinkEntityIds)
    const target = input.targetEntityId

    switch (input.kind) {
      case 'match': {
        if (!nonEmpty(target)) {
          throw new InstanceReviewError('INVALID_ARGUMENT', 'a match requires a targetEntityId')
        }
        const candidate = candidates.find((entry) => entry.entityId === target)
        if (candidate === undefined) {
          throw new InstanceReviewError('IDENTITY_CONFLICT', `entity ${target} was not recalled for this record`)
        }
        if (cannotLink.has(target)) {
          throw new InstanceReviewError('IDENTITY_CONFLICT', `entity ${target} is cannot-linked with this record`)
        }
        if (candidate.objectId !== record.objectTypeRef) {
          throw new InstanceReviewError(
            'IDENTITY_CONFLICT',
            `entity ${target} is a ${candidate.objectId}, not the record's ${record.objectTypeRef}`,
          )
        }
        state = 'matched'
        matchedEntityId = target
        break
      }
      case 'create': {
        state = 'created'
        matchedEntityId = input.resolvedEntityId ?? matchedEntityId ?? this.#newId()
        break
      }
      case 'cannot_link': {
        if (!nonEmpty(target)) {
          throw new InstanceReviewError('INVALID_ARGUMENT', 'a cannot-link requires a targetEntityId')
        }
        if (record.identity.matchedEntityId === target) {
          throw new InstanceReviewError(
            'IDENTITY_CONFLICT',
            `entity ${target} is currently matched; split it before recording a cannot-link`,
          )
        }
        cannotLink.add(target)
        if (state === 'unresolved') state = 'rejected'
        break
      }
      case 'split': {
        if (!nonEmpty(target) || record.identity.matchedEntityId !== target) {
          throw new InstanceReviewError(
            'IDENTITY_CONFLICT',
            'a split requires the currently matched targetEntityId',
          )
        }
        state = 'split'
        matchedEntityId = undefined
        break
      }
    }

    const revision = String(record.identity.adjudications.length + 1)
    const adjudications: InstanceIdentityAdjudication[] = [
      ...record.identity.adjudications,
      {
        decisionId: this.#newId(),
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        ...(nonEmpty(target) ? { targetEntityId: target } : {}),
        reason: input.reason,
        actor: record.actor,
        recordedAt,
        revision,
      },
    ]
    const confidence: InstanceIdentityConfidence =
      state === 'matched' || state === 'created'
        ? 'exact'
        : confidenceFromCandidates(record.objectTypeRef, candidates)

    return this.#deps.store.appendRecordRevision(
      scopeRef,
      projectId,
      {
        recordId,
        expectedRevision: record.recordRevision,
        objectTypeRef: record.objectTypeRef,
        identityCandidates: candidates,
        ...(record.identity.binding === undefined ? {} : { identityBinding: record.identity.binding }),
        identityState: state,
        identityConfidence: confidence,
        ...(matchedEntityId === undefined ? {} : { matchedEntityId }),
        sameNameDifferentMeaning: record.identity.sameNameDifferentMeaning,
        cannotLinkEntityIds: [...cannotLink],
        adjudications,
        fields: record.fields,
        relations: record.relations,
        publicationState: record.publicationState,
        ...(record.publishedRevision === undefined ? {} : { publishedRevision: record.publishedRevision }),
        sourceRef: record.sourceRef,
        actor: record.actor,
        recordedAt,
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )
  }

  /** Approve a revision for publication; pending/conflict fields and endpoints block it. */
  async approve(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    input: { readonly expectedRevision: RevisionString; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    const record = await this.#requireRecord(scopeRef, projectId, recordId, ctx)
    if (record.recordRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record is at revision ${record.recordRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    const blockers = this.#publishBlockers(record)
    if (blockers.length > 0) {
      throw new InstanceReviewError('PUBLICATION_BLOCKED', `cannot approve: ${blockers.join('; ')}`)
    }
    return this.#appendRevision(scopeRef, projectId, record, ctx, {
      recordId,
      fields: record.fields,
      publicationState: 'approved',
      recordedAt: this.#now(),
      idempotencyKey: input.idempotencyKey,
    })
  }

  /** Publish an approved revision and pin the published revision a read-back returns. */
  async publish(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    input: { readonly expectedRevision: RevisionString; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    scopeOf(ctx)
    const record = await this.#requireRecord(scopeRef, projectId, recordId, ctx)
    if (record.recordRevision !== input.expectedRevision) {
      throw new InstanceReviewError(
        'VERSION_CONFLICT',
        `record is at revision ${record.recordRevision}, not the expected ${input.expectedRevision}`,
      )
    }
    if (record.publicationState !== 'approved') {
      throw new InstanceReviewError('PUBLICATION_BLOCKED', 'the record must be approved before it can be published')
    }
    const blockers = this.#publishBlockers(record)
    if (blockers.length > 0) {
      throw new InstanceReviewError('PUBLICATION_BLOCKED', `cannot publish: ${blockers.join('; ')}`)
    }
    const publishedRevision = nextRevision(record.recordRevision)
    return this.#deps.store.appendRecordRevision(
      scopeRef,
      projectId,
      {
        recordId,
        expectedRevision: record.recordRevision,
        objectTypeRef: record.objectTypeRef,
        identityCandidates: record.identity.candidates,
        ...(record.identity.binding === undefined ? {} : { identityBinding: record.identity.binding }),
        identityState: record.identity.state,
        identityConfidence: record.identity.confidence,
        ...(record.identity.matchedEntityId === undefined
          ? {}
          : { matchedEntityId: record.identity.matchedEntityId }),
        sameNameDifferentMeaning: record.identity.sameNameDifferentMeaning,
        cannotLinkEntityIds: record.identity.cannotLinkEntityIds,
        adjudications: record.identity.adjudications,
        fields: record.fields,
        relations: record.relations,
        publicationState: 'published',
        publishedRevision,
        sourceRef: record.sourceRef,
        actor: record.actor,
        recordedAt: this.#now(),
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )
  }

  #initialField(objectTypeRef: string, field: CreateInstanceFieldInput): InstanceFieldValue {
    const rejection = this.#deps.fieldPolicy?.validate({
      objectTypeRef,
      fieldId: field.fieldId,
      rawValue: field.rawValue,
      ...(field.normalizedValue === undefined ? {} : { normalizedValue: field.normalizedValue }),
    })
    const missingValue = field.normalizedValue === undefined
    const reason = rejection ?? (missingValue ? 'no normalized value yet' : undefined)
    return {
      fieldId: field.fieldId,
      rawValue: field.rawValue,
      ...(field.normalizedValue === undefined ? {} : { normalizedValue: field.normalizedValue }),
      source: field.source,
      status: 'pending',
      ...(reason === undefined ? {} : { reason }),
      confirmationRevision: '0',
    }
  }

  #confirmBlocker(objectTypeRef: string, field: InstanceFieldValue): string | undefined {
    if (field.normalizedValue === undefined) return 'field has no normalized value'
    const rejection = this.#deps.fieldPolicy?.validate({
      objectTypeRef,
      fieldId: field.fieldId,
      rawValue: field.rawValue,
      normalizedValue: field.normalizedValue,
    })
    return rejection
  }

  #publishBlockers(record: InstanceRecordView): string[] {
    const blockers: string[] = []
    for (const field of record.fields) {
      if (field.status !== 'confirmed') blockers.push(`field ${field.fieldId} is ${field.status}`)
    }
    for (const relation of record.relations) {
      if (relation.endpointState === 'pending') blockers.push(`relation ${relation.relationId} endpoint is pending`)
    }
    if (record.identity.state === 'unresolved') blockers.push('identity is unresolved')
    if (record.identity.sameNameDifferentMeaning && record.identity.state !== 'matched' && record.identity.state !== 'created') {
      blockers.push('identity has a same-name/different-meaning candidate that is not adjudicated')
    }
    return blockers
  }

  async #recordConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    record: InstanceRecordView,
    field: InstanceFieldValue | undefined,
    status: InstanceFieldValue['status'],
    reason: string | undefined,
    recordedAt: string,
    input: FieldConfirmationInput,
    ctx: ToolContext,
    fieldId?: string,
  ): Promise<void> {
    await this.#deps.store.appendConfirmation(
      scopeRef,
      projectId,
      {
        recordId: record.recordId,
        fieldId: fieldId ?? field?.fieldId ?? '',
        recordRevision: record.recordRevision,
        status,
        ...(reason === undefined ? {} : { reason }),
        sourceRef: field?.source.documentRef ?? record.sourceRef,
        actor: record.actor,
        recordedAt,
        idempotencyKey: `${input.idempotencyKey}:event:${fieldId ?? field?.fieldId ?? ''}`,
      },
      ctx,
    )
  }

  async #appendRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    record: InstanceRecordView,
    ctx: ToolContext,
    input: {
      readonly recordId: Uuid
      readonly fields: readonly InstanceFieldValue[]
      readonly publicationState: InstanceRecordView['publicationState']
      readonly recordedAt: string
      readonly idempotencyKey: string
    },
  ): Promise<InstanceRecordView> {
    return this.#deps.store.appendRecordRevision(
      scopeRef,
      projectId,
      {
        recordId: input.recordId,
        expectedRevision: record.recordRevision,
        objectTypeRef: record.objectTypeRef,
        identityCandidates: record.identity.candidates,
        ...(record.identity.binding === undefined ? {} : { identityBinding: record.identity.binding }),
        identityState: record.identity.state,
        identityConfidence: record.identity.confidence,
        ...(record.identity.matchedEntityId === undefined
          ? {}
          : { matchedEntityId: record.identity.matchedEntityId }),
        sameNameDifferentMeaning: record.identity.sameNameDifferentMeaning,
        cannotLinkEntityIds: record.identity.cannotLinkEntityIds,
        adjudications: record.identity.adjudications,
        fields: input.fields,
        relations: record.relations,
        publicationState: input.publicationState,
        ...(record.publishedRevision === undefined ? {} : { publishedRevision: record.publishedRevision }),
        sourceRef: record.sourceRef,
        actor: record.actor,
        recordedAt: input.recordedAt,
        idempotencyKey: input.idempotencyKey,
      },
      ctx,
    )
  }

  async #resolveRelations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    relations: readonly CreateInstanceRelationInput[],
    ctx: ToolContext,
  ): Promise<InstanceRelationEndpoint[]> {
    const resolved: InstanceRelationEndpoint[] = []
    for (const relation of relations) {
      if (!nonEmpty(relation.relationId)) {
        throw new InstanceReviewError('INVALID_ARGUMENT', 'a relation requires a non-empty relationId')
      }
      const target =
        relation.toRecordId === undefined ? undefined : await this.#deps.store.getRecord(scopeRef, projectId, relation.toRecordId, ctx)
      const endpointState: InstanceRelationEndpoint['endpointState'] =
        target === undefined ? 'pending' : 'resolved'
      resolved.push({
        relationId: relation.relationId,
        relationTypeRef: relation.relationTypeRef,
        fromRecordId: recordId,
        ...(relation.toRecordId === undefined ? {} : { toRecordId: relation.toRecordId }),
        endpointState,
      })
    }
    return resolved
  }

  async #requireRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    const record = await this.#deps.store.getRecord(scopeRef, projectId, recordId, ctx)
    if (record === undefined) {
      throw new InstanceReviewError('RECORD_NOT_FOUND', `record ${recordId} is not visible in this scope`)
    }
    return record
  }
}
